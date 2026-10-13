// 可录入范围沿用现有表单，属于输入校验，不代表正常范围或分诊结论。
export const VITAL_RANGES = {
  systolic: { min: 60, max: 260, integer: true, label: '收缩压', unit: 'mmHg' },
  diastolic: { min: 30, max: 180, integer: true, label: '舒张压', unit: 'mmHg' },
  heart_rate: { min: 30, max: 200, integer: true, label: '心率', unit: '次/分' },
  temperature: { min: 33, max: 42, integer: false, label: '体温', unit: '℃' },
  blood_glucose: { min: 2, max: 30, integer: false, label: '血糖', unit: 'mmol/L' },
  weight: { min: 20, max: 200, integer: false, label: '体重', unit: 'kg' },
  pain_score: { min: 0, max: 10, integer: true, label: '疼痛评分', unit: '分' },
} as const;

export type VitalKey = keyof typeof VITAL_RANGES;
export type VitalValues = Partial<Record<VitalKey, unknown>>;

export function parseVitalNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  // 不截取“120abc”，不接受指数、Infinity 或 NaN。
  if (!/^\d+(?:\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

export function validateVitals(values: VitalValues, requirePressurePair = false): string | null {
  for (const key of Object.keys(VITAL_RANGES) as VitalKey[]) {
    const value = values[key];
    if (value === null || value === undefined) continue;
    const rule = VITAL_RANGES[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return `请填写有效的${rule.label}数字`;
    if (rule.integer && !Number.isInteger(value)) return `${rule.label}请填写整数`;
    if (value < rule.min || value > rule.max) return `${rule.label}可录入 ${rule.min}–${rule.max} ${rule.unit}，请核对读数和单位`;
  }
  const sys = values.systolic;
  const dia = values.diastolic;
  if (requirePressurePair && (sys != null) !== (dia != null)) return '血压需要同时填写收缩压和舒张压';
  if (typeof sys === 'number' && typeof dia === 'number' && sys <= dia) return '收缩压应高于舒张压，请核对两项是否填反';
  return null;
}
