export type PixelPrintTarget = 'h5' | 'rn';

export interface PixelPrintTargetConfig {
  target: PixelPrintTarget;
  skillName: 'pp-d2c' | 'pp-d2c-rn';
  configFile: string;
  skillFile: string;
}

/** 返回 H5/RN 对应的固定模板配置与 Skill 路径。 */
export function resolveTarget(target: PixelPrintTarget): PixelPrintTargetConfig {
  const skillName = target === 'h5' ? 'pp-d2c' : 'pp-d2c-rn';
  return {
    target,
    skillName,
    configFile: `templates/${target === 'h5' ? 'pp-d2c' : 'pp-d2c.rn'}.config.json`,
    skillFile: `templates/skills/${skillName}/SKILL.md`,
  };
}
