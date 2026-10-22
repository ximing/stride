export type EditorColor = { id: string; hue: string; step: number; value: string }

/** Black to white, then ten hues from vivid through pale to deep. Matches the document color grid. */
const GRAYS = ['#000000', '#1f1f1f', '#3d3d3d', '#595959', '#8c8c8c', '#bfbfbf', '#d9d9d9', '#e8e8e8', '#f5f5f5', '#ffffff']

const SCALES: Record<string, readonly string[]> = {
  red: ['#ff4d4f', '#fff1f0', '#ffccc7', '#ff7875', '#cf1322', '#820014'],
  orange: ['#ffa940', '#fff7e6', '#ffe7ba', '#ffc069', '#d46b08', '#873800'],
  yellow: ['#fadb14', '#feffe6', '#ffffb8', '#fff566', '#d4b106', '#876800'],
  green: ['#52c41a', '#f6ffed', '#d9f7be', '#95de64', '#389e0d', '#135200'],
  cyan: ['#13c2c2', '#e6fffb', '#b5f5ec', '#5cdbd3', '#08979c', '#00474f'],
  blue: ['#1890ff', '#e6f7ff', '#bae7ff', '#69c0ff', '#096dd9', '#003a8c'],
  indigo: ['#2f54eb', '#f0f5ff', '#d6e4ff', '#85a5ff', '#1d39c4', '#061178'],
  purple: ['#722ed1', '#f9f0ff', '#efdbff', '#b37feb', '#531dab', '#22075e'],
  magenta: ['#eb2f96', '#fff0f6', '#ffd6e7', '#ff85c0', '#c41d7f', '#780650'],
  pink: ['#ff5c94', '#fff0f3', '#ffd6e0', '#ff85ad', '#e11d64', '#8a1248'],
}

function grid(): EditorColor[] {
  const colors: EditorColor[] = GRAYS.map((value, index) => ({
    id: `gray-${index + 1}`,
    hue: 'gray',
    step: index + 1,
    value,
  }))
  const rows = SCALES.red.length
  for (let row = 0; row < rows; row += 1) {
    for (const [hue, scale] of Object.entries(SCALES)) {
      colors.push({ id: `${hue}-${row + 1}`, hue, step: row + 1, value: scale[row] })
    }
  }
  return colors
}

export const EDITOR_COLORS: readonly EditorColor[] = grid()

export const TEXT_COLORS = EDITOR_COLORS
export const BACKGROUND_COLORS = EDITOR_COLORS

export function colorLabel(t: (key: string, options?: Record<string, unknown>) => string, color: EditorColor): string {
  return t('editor.color.step', { name: t(`editor.color.${color.hue}`), step: color.step })
}
