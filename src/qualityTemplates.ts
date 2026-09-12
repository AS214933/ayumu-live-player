import type {
  ComplexPlayerConfig,
  PlayerConfig,
  StreamFormat,
  StreamQuality,
  TemplateControlCondition,
  TemplateControlConfig,
  TemplateControlPlacement,
  TemplateDerivedVariableConfig,
  TemplateValue,
  TemplateVariable,
} from "./playerConfig";

const TEMPLATE_PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;
const TEMPLATE_NAMED_PLACEHOLDER_PATTERN = /^([a-zA-Z_][\w-]*)(?:\s*:\s*[\s\S]+)?$/;
const SUPPORTED_STREAM_FORMATS = new Set<StreamFormat>(["flv", "m3u8"]);
const DEFAULT_CONTROL_INDEX = 10;

export type TemplateContext = Record<string, TemplateValue>;

export type TemplateSelectionOption = {
  value: TemplateValue;
  label: string;
};

export type TemplateSelectionControl = {
  name: string;
  label: string;
  placement: TemplateControlPlacement;
  index?: number;
  hiddenWhen?: TemplateControlCondition | TemplateControlCondition[];
  selectedValue: TemplateValue;
  options: TemplateSelectionOption[];
};

export type ResolvedTemplateSource = {
  controls: TemplateSelectionControl[];
  selectedValues: TemplateContext;
  createQuality: (values: TemplateContext) => StreamQuality;
};

export type ResolvedPlayerSources = {
  qualities: StreamQuality[];
  isComplexMode: boolean;
  template?: ResolvedTemplateSource;
};

type TemplateDescriptor = {
  variableNames: string[];
  variableDefinitions: Map<string, TemplateVariable>;
  derivedVariables: Record<string, TemplateDerivedVariableConfig>;
};

export function resolvePlayerSources(config: PlayerConfig): ResolvedPlayerSources {
  if (!config.complex?.enabled) {
    return {
      qualities: config.qualities,
      isComplexMode: false,
    };
  }

  return createTemplateSources(config.complex);
}

export function resolvePlayerQualities(config: PlayerConfig): StreamQuality[] {
  return resolvePlayerSources(config).qualities;
}

function createTemplateSources(config: ComplexPlayerConfig): ResolvedPlayerSources {
  const descriptor = createTemplateDescriptor(config);
  const contexts = expandTemplateContexts(descriptor.variableNames, descriptor.variableDefinitions);
  const defaultIndex = findDefaultContextIndex(contexts, config.defaultValues);
  const selectedValues = contexts[defaultIndex] ?? {};
  const controls = createTemplateControls(
    config,
    descriptor.variableNames,
    descriptor.variableDefinitions,
    selectedValues,
  );

  return {
    qualities: contexts.map((context, index) =>
      createTemplateQuality(config, descriptor, context, index === defaultIndex),
    ),
    isComplexMode: true,
    template: {
      controls,
      selectedValues,
      createQuality: (values) => createTemplateQuality(config, descriptor, values),
    },
  };
}

function createTemplateDescriptor(config: ComplexPlayerConfig): TemplateDescriptor {
  const derivedVariables = config.derivedVariables ?? {};
  const derivedVariableNames = new Set(Object.keys(derivedVariables));
  const variableNames = collectVariableNames(config, derivedVariableNames);
  const variableDefinitions = new Map<string, TemplateVariable>();

  for (const name of variableNames) {
    const controlConfig = config.controls?.[name];
    const controlValues = getControlValues(name, controlConfig);

    if (controlConfig?.enabled === false || controlConfig?.hidden) {
      variableDefinitions.set(name, getLockedControlValue(name, config, controlValues));
      continue;
    }

    if (controlValues.length > 0) {
      variableDefinitions.set(name, controlValues);
      continue;
    }

    if (config.variables && name in config.variables) {
      variableDefinitions.set(name, config.variables[name]);
      continue;
    }

    throw new Error(
      `复杂模式变量 ${name} 缺少可选值，请在 controls.${name}.valueLabels 或 variables.${name} 中配置。`,
    );
  }

  return {
    variableNames,
    variableDefinitions,
    derivedVariables,
  };
}

function collectVariableNames(config: ComplexPlayerConfig, derivedVariableNames: Set<string>) {
  const names: string[] = [];

  for (const template of [config.urlTemplate, config.nameTemplate ?? ""]) {
    addTemplateVariableNames(names, template, derivedVariableNames);
  }

  for (const derivedVariable of Object.values(config.derivedVariables ?? {})) {
    addTemplateVariableNames(names, derivedVariable.template, derivedVariableNames);

    for (const name of Object.keys(derivedVariable.emptyWhen ?? {})) {
      addTemplateVariableName(names, name, derivedVariableNames);
    }
  }

  for (const controlConfig of Object.values(config.controls ?? {})) {
    for (const condition of normalizeTemplateConditions(controlConfig.hiddenWhen)) {
      for (const name of Object.keys(condition)) {
        addTemplateVariableName(names, name, derivedVariableNames);
      }
    }
  }

  return names;
}

function addTemplateVariableNames(
  names: string[],
  template: string,
  derivedVariableNames: Set<string>,
) {
  for (const placeholder of template.matchAll(TEMPLATE_PLACEHOLDER_PATTERN)) {
    addTemplateVariableName(names, parseTemplateVariableName(placeholder[1]), derivedVariableNames);
  }
}

function addTemplateVariableName(
  names: string[],
  name: string,
  derivedVariableNames: Set<string>,
) {
  if (!isDerivedLabelName(name) && !derivedVariableNames.has(name) && !names.includes(name)) {
    names.push(name);
  }
}

function parseTemplateVariableName(content: string) {
  const trimmedContent = content.trim();
  const namedMatch = trimmedContent.match(TEMPLATE_NAMED_PLACEHOLDER_PATTERN);

  if (!namedMatch) {
    throw new Error(
      `复杂模式模板占位符 {${trimmedContent}} 缺少变量名，请改成 {变量名}，可选值放到 controls.变量名.valueLabels。`,
    );
  }

  return namedMatch[1];
}

function getControlValues(
  name: string,
  controlConfig: TemplateControlConfig | undefined,
): TemplateValue[] {
  const hasExplicitValues = Boolean(controlConfig?.values);
  const values = [...(controlConfig?.values ?? Object.keys(controlConfig?.valueLabels ?? {}))];

  if (name !== "quality" || hasExplicitValues) {
    return values;
  }

  return values.sort(compareQualityValues);
}

function compareQualityValues(left: TemplateValue, right: TemplateValue) {
  const leftValue = String(left);
  const rightValue = String(right);

  if (leftValue === "" && rightValue !== "") {
    return -1;
  }

  if (rightValue === "" && leftValue !== "") {
    return 1;
  }

  const leftNumber = Number(leftValue);
  const rightNumber = Number(rightValue);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return rightNumber - leftNumber;
  }

  return 0;
}

function getLockedControlValue(
  name: string,
  config: ComplexPlayerConfig,
  controlValues: TemplateValue[],
): TemplateValue {
  if (hasTemplateValue(config.defaultValues, name)) {
    return config.defaultValues![name];
  }

  if (controlValues.length > 0) {
    return controlValues[0];
  }

  if (config.variables && name in config.variables) {
    const values = normalizeTemplateVariable(config.variables[name]);

    if (values.length > 0) {
      return values[0];
    }
  }

  throw new Error(`复杂模式变量 ${name} 已禁用，但缺少默认值。`);
}

function hasTemplateValue(values: Record<string, TemplateValue> | undefined, name: string) {
  return Boolean(values && Object.prototype.hasOwnProperty.call(values, name));
}

function expandTemplateContexts(
  variableNames: string[],
  variableDefinitions: Map<string, TemplateVariable>,
): TemplateContext[] {
  return variableNames.reduce<TemplateContext[]>((contexts, name) => {
    const values = normalizeTemplateVariable(variableDefinitions.get(name));

    return contexts.flatMap((context) =>
      values.map((value) => ({
        ...context,
        [name]: value,
      })),
    );
  }, [{}]);
}

function normalizeTemplateVariable(variable: TemplateVariable | undefined): TemplateValue[] {
  if (variable === undefined) {
    return [];
  }

  if (typeof variable === "string" || typeof variable === "number") {
    return [variable];
  }

  if (Array.isArray(variable)) {
    return variable;
  }

  if ("values" in variable) {
    return variable.values;
  }

  const [from, to] = variable.range;
  const direction = from <= to ? 1 : -1;
  const absoluteStep = Math.abs(variable.step ?? 1);

  if (absoluteStep === 0) {
    throw new Error("复杂模式 range 的 step 不能为 0。");
  }

  const step = absoluteStep * direction;
  const values: TemplateValue[] = [];

  for (let value = from; direction > 0 ? value <= to : value >= to; value += step) {
    values.push(formatRangeValue(value, variable.padStart));
  }

  return values;
}

function formatRangeValue(value: number, padStart: number | undefined): TemplateValue {
  if (!padStart) {
    return value;
  }

  const sign = value < 0 ? "-" : "";
  return `${sign}${String(Math.abs(value)).padStart(padStart, "0")}`;
}

function createTemplateQuality(
  config: ComplexPlayerConfig,
  descriptor: TemplateDescriptor,
  context: TemplateContext,
  isDefault = false,
): StreamQuality {
  const normalizedContext = normalizeHiddenControlValues(config, descriptor, context);
  const renderContext = createRenderContext(config, descriptor, normalizedContext);
  const url = renderTemplate(config.urlTemplate, renderContext);
  const format = getContextStreamFormat(normalizedContext) ?? inferStreamFormat(url) ?? undefined;

  return {
    name: normalizeQualityName(
      config.nameTemplate
        ? renderTemplate(config.nameTemplate, renderContext)
        : createDefaultQualityName(config, normalizedContext),
    ),
    url,
    default: isDefault,
    format,
    codec: getContextCodec(normalizedContext) ?? (format ? config.codecs?.[format] : undefined) ?? config.codec,
  };
}

function normalizeHiddenControlValues(
  config: ComplexPlayerConfig,
  descriptor: TemplateDescriptor,
  context: TemplateContext,
): TemplateContext {
  return Object.entries(config.controls ?? {}).reduce<TemplateContext>(
    (normalizedContext, [name, controlConfig]) => {
      if (!matchesTemplateCondition(controlConfig.hiddenWhen, normalizedContext)) {
        return normalizedContext;
      }

      return {
        ...normalizedContext,
        [name]: getHiddenControlDefaultValue(name, config, descriptor, normalizedContext),
      };
    },
    { ...context },
  );
}

function getHiddenControlDefaultValue(
  name: string,
  config: ComplexPlayerConfig,
  descriptor: TemplateDescriptor,
  context: TemplateContext,
): TemplateValue {
  if (hasTemplateValue(config.defaultValues, name)) {
    return config.defaultValues![name];
  }

  const values = normalizeTemplateVariable(descriptor.variableDefinitions.get(name));
  return values[0] ?? context[name] ?? "";
}

function createTemplateControls(
  config: ComplexPlayerConfig,
  variableNames: string[],
  variableDefinitions: Map<string, TemplateVariable>,
  selectedValues: TemplateContext,
): TemplateSelectionControl[] {
  let controlIndex = 0;

  return variableNames
    .flatMap((name, variableIndex): TemplateSelectionControl[] => {
      const controlConfig = config.controls?.[name];
      const values = normalizeTemplateVariable(variableDefinitions.get(name));

      if (controlConfig?.enabled === false || controlConfig?.hidden || (!controlConfig && values.length <= 1)) {
        return [];
      }

      const placement = controlConfig?.placement ?? "control";
      const index = controlConfig?.index ?? getDefaultControlIndex(placement, controlIndex, variableIndex);

      if (placement === "control") {
        controlIndex += 1;
      }

      return [
        {
          name,
          label: getControlLabel(name, controlConfig),
          placement,
          index,
          hiddenWhen: controlConfig?.hiddenWhen,
          selectedValue: selectedValues[name] ?? values[0],
          options: values.map((value) => ({
            value,
            label: getValueLabel(name, value, controlConfig),
          })),
        },
      ];
    })
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
}

function getDefaultControlIndex(
  placement: TemplateControlPlacement,
  controlIndex: number,
  variableIndex: number,
) {
  if (placement === "control") {
    return DEFAULT_CONTROL_INDEX + controlIndex;
  }

  return variableIndex;
}

function getControlLabel(name: string, controlConfig: TemplateControlConfig | undefined) {
  if (controlConfig?.label) {
    return controlConfig.label;
  }

  if (name === "route_id" || name === "route" || name === "line") {
    return "线路";
  }

  if (name === "stream_format") {
    return "格式";
  }

  if (name === "quality") {
    return "清晰度";
  }

  if (name === "codec" || name === "format" || name === "video_codec" || name === "encoding") {
    return "编码";
  }

  return name;
}

function getValueLabel(
  name: string,
  value: TemplateValue,
  controlConfig: TemplateControlConfig | undefined,
) {
  const valueLabel = controlConfig?.valueLabels?.[String(value)];

  if (valueLabel) {
    return valueLabel;
  }

  if (value === "") {
    return "Auto";
  }

  if (
    name === "stream_format" ||
    name === "format" ||
    name === "codec" ||
    name === "video_codec" ||
    name === "encoding"
  ) {
    return String(value).toUpperCase();
  }

  return String(value);
}

function createRenderContext(
  config: ComplexPlayerConfig,
  descriptor: TemplateDescriptor,
  context: TemplateContext,
): TemplateContext {
  const renderContext: TemplateContext = { ...context };

  for (const [name, value] of Object.entries(context)) {
    renderContext[`${name}_label`] = getValueLabel(name, value, config.controls?.[name]);
  }

  for (const [name, controlConfig] of Object.entries(config.controls ?? {})) {
    if (matchesTemplateCondition(controlConfig.hiddenWhen, context)) {
      renderContext[`${name}_label`] = "";
    }
  }

  for (const [name, derivedVariable] of Object.entries(descriptor.derivedVariables)) {
    const value = renderDerivedVariable(derivedVariable, renderContext);
    renderContext[name] = value;
    renderContext[`${name}_label`] = String(value);
  }

  return renderContext;
}

function renderDerivedVariable(
  derivedVariable: TemplateDerivedVariableConfig,
  context: TemplateContext,
): TemplateValue {
  if (shouldUseEmptyDerivedValue(derivedVariable, context)) {
    return "";
  }

  return renderTemplate(derivedVariable.template, context);
}

function shouldUseEmptyDerivedValue(
  derivedVariable: TemplateDerivedVariableConfig,
  context: TemplateContext,
) {
  return matchesTemplateCondition(derivedVariable.emptyWhen, context);
}

function matchesTemplateCondition(
  condition: TemplateControlCondition | TemplateControlCondition[] | undefined,
  context: TemplateContext,
) {
  return normalizeTemplateConditions(condition).some((item) => {
    const entries = Object.entries(item ?? {});

    return entries.length > 0 && entries.every(
      ([name, value]) => String(context[name]) === String(value),
    );
  });
}

function normalizeTemplateConditions(
  condition: TemplateControlCondition | TemplateControlCondition[] | undefined,
) {
  return Array.isArray(condition) ? condition : condition ? [condition] : [];
}

function renderTemplate(template: string, context: TemplateContext) {
  return template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_match, rawContent: string) => {
    const name = parseTemplateVariableName(rawContent);
    const value = context[name];

    if (value === undefined) {
      throw new Error(`复杂模式模板缺少变量：${name}`);
    }

    return String(value);
  });
}

function normalizeQualityName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

function createDefaultQualityName(config: ComplexPlayerConfig, context: TemplateContext) {
  const routeName = getFirstExistingContextName(context, ["route_id", "route", "line"]);
  const qualityName = getFirstExistingContextName(context, ["quality"]);
  const codecName = getFirstExistingContextName(context, ["codec", "format", "video_codec", "encoding"]);
  const streamFormatName = getFirstExistingContextName(context, ["stream_format"]);
  const nameParts = [routeName, qualityName, codecName]
    .map((name) => (name ? getValueLabel(name, context[name], config.controls?.[name]) : undefined))
    .filter(Boolean);

  if (streamFormatName) {
    nameParts.push(`(${getValueLabel(streamFormatName, context[streamFormatName], config.controls?.[streamFormatName])})`);
  }

  if (nameParts.length > 0) {
    return nameParts.join(" ");
  }

  return Object.entries(context)
    .map(([name, value]) => `${getControlLabel(name, config.controls?.[name])}: ${getValueLabel(
      name,
      value,
      config.controls?.[name],
    )}`)
    .join(" / ");
}

function getFirstExistingContextName(context: TemplateContext, names: string[]) {
  return names.find((name) => context[name] !== undefined);
}

function findDefaultContextIndex(contexts: TemplateContext[], defaultValues: Record<string, TemplateValue> = {}) {
  if (contexts.length === 0) {
    return -1;
  }

  const defaultEntries = Object.entries(defaultValues);

  if (defaultEntries.length === 0) {
    return 0;
  }

  const matchedIndex = contexts.findIndex((context) =>
    defaultEntries.every(([name, value]) => String(context[name]) === String(value)),
  );

  return matchedIndex >= 0 ? matchedIndex : 0;
}

function getContextStreamFormat(context: TemplateContext): StreamFormat | null {
  const streamFormat = context.stream_format;

  if (typeof streamFormat !== "string") {
    return null;
  }

  const normalizedFormat = streamFormat.toLowerCase();
  return isStreamFormat(normalizedFormat) ? normalizedFormat : null;
}

function inferStreamFormat(url: string): StreamFormat | null {
  const normalizedUrl = url.split("?")[0].split("#")[0].toLowerCase();

  if (normalizedUrl.endsWith(".m3u8")) {
    return "m3u8";
  }

  if (normalizedUrl.endsWith(".flv")) {
    return "flv";
  }

  return null;
}

function isStreamFormat(format: string): format is StreamFormat {
  return SUPPORTED_STREAM_FORMATS.has(format as StreamFormat);
}

function isDerivedLabelName(name: string) {
  return name.endsWith("_label");
}

function getContextCodec(context: TemplateContext): StreamQuality["codec"] | undefined {
  if (hasTemplateValue(context, "quality") && context.quality === "") {
    return undefined;
  }

  const codec = context.codec ?? context.format ?? context.video_codec ?? context.encoding;
  return codec === "avc" || codec === "hevc" ? codec : undefined;
}
