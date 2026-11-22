export interface AdfText {
  type: 'text';
  text: string;
  marks?: Array<{ type: 'strong' } | { type: 'code' }>;
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Array<AdfNode | AdfText>;
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

export const text = (value: string): AdfText => ({ type: 'text', text: value });
export const strong = (value: string): AdfText => ({
  type: 'text',
  text: value,
  marks: [{ type: 'strong' }],
});
export const code = (value: string): AdfText => ({
  type: 'text',
  text: value,
  marks: [{ type: 'code' }],
});

export const paragraph = (...content: AdfText[]): AdfNode => ({ type: 'paragraph', content });

export const heading = (level: number, value: string): AdfNode => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});

export const bulletList = (items: AdfText[][]): AdfNode => ({
  type: 'bulletList',
  content: items.map((item) => ({ type: 'listItem', content: [paragraph(...item)] })),
});

export const panel = (
  panelType: 'info' | 'warning' | 'error' | 'success',
  ...content: AdfNode[]
): AdfNode => ({
  type: 'panel',
  attrs: { panelType },
  content,
});

export const doc = (...content: AdfNode[]): AdfDoc => ({ type: 'doc', version: 1, content });
