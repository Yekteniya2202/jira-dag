import type { JiraEdge } from '../shared/contracts';
import type { Direction } from './graph-model';

export type GraphExportFormat = 'pdf' | 'png' | 'mermaid';

function intersects(left: DOMRect, right: DOMRect): boolean {
  return left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
}

function covers(outer: DOMRect, inner: DOMRect): boolean {
  const tolerance = 1;
  return outer.left <= inner.left + tolerance && outer.top <= inner.top + tolerance &&
    outer.right >= inner.right - tolerance && outer.bottom >= inner.bottom - tolerance;
}

function caption(value: string): string {
  return `"${value.replace(/\s+/g, ' ').trim().replace(/["#<>&|[\]`]/g, (character) => `#${character.charCodeAt(0)};`)}"`;
}

function mermaid(canvas: HTMLElement, direction: Direction, edges: readonly JiraEdge[], parentLabel: string): string {
  const viewport = canvas.getBoundingClientRect();
  const zones = Array.from(canvas.querySelectorAll<HTMLElement>('[data-export-zone]')).flatMap((element, index) => {
    const rect = element.getBoundingClientRect();
    const label = element.querySelector('.graph-zone-title')?.textContent?.trim();
    return label && intersects(rect, viewport) ? [{ id: `g${index + 1}`, label, rect }] : [];
  }).sort((left, right) => left.rect.width * left.rect.height - right.rect.width * right.rect.height);
  const keys = new Map<string, string>();
  const nodes = Array.from(canvas.querySelectorAll<HTMLElement>('.react-flow__node-issue[data-id]')).flatMap((element, index) => {
    const rect = element.getBoundingClientRect();
    const key = element.dataset.id;
    if (!key || !intersects(rect, viewport)) return [];
    const title = element.querySelector('.issue-card-title')?.textContent?.trim();
    const id = `n${index + 1}`;
    keys.set(key, id);
    return [{ id, label: title ? `${key} · ${title}` : key, rect }];
  });
  const lines: string[] = [`flowchart ${direction}`];
  const zoneParents = new Map<string, string | undefined>();
  zones.forEach((zone, index) => zoneParents.set(zone.id, zones.slice(index + 1).find(({ rect }) => covers(rect, zone.rect))?.id));
  const nodeParents = new Map(nodes.map((node) => [node.id, zones.find(({ rect }) => covers(rect, node.rect))?.id]));

  function renderItems(parent: string | undefined, indent: string) {
    for (const zone of zones) {
      if (zoneParents.get(zone.id) !== parent) continue;
      lines.push(`${indent}subgraph ${zone.id}[${caption(zone.label)}]`);
      renderItems(zone.id, `${indent}  `);
      lines.push(`${indent}end`);
    }
    for (const node of nodes) {
      if (nodeParents.get(node.id) === parent) lines.push(`${indent}${node.id}[${caption(node.label)}]`);
    }
  }
  renderItems(undefined, '  ');

  const visibleEdges = new Set(Array.from(canvas.querySelectorAll<HTMLElement>('.react-flow__edge[data-id]'),
    ({ dataset }) => dataset.id));
  for (const edge of edges) {
    const source = keys.get(edge.source);
    const target = keys.get(edge.target);
    if (!source || !target || !visibleEdges.has(edge.id)) continue;
    const label = caption(edge.kind === 'parent' ? parentLabel : edge.label);
    lines.push(`  ${source} ${edge.kind === 'parent' ? '-.->' : '-->'}|${label}| ${target}`);
  }
  Array.from(canvas.querySelectorAll<HTMLElement>('[data-export-note]')).forEach((element, index) => {
    if (!intersects(element.getBoundingClientRect(), viewport)) return;
    const label = element.querySelector('.graph-note-sticker-text')?.textContent?.trim();
    if (!label) return;
    const id = `note${index + 1}`;
    lines.push(`  ${id}[${caption(label)}]`);
    const issue = keys.get(element.dataset.exportNote ?? '');
    if (issue) lines.push(`  ${issue} -.- ${id}`);
  });
  return `${lines.join('\n')}\n`;
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const embeddedFontFiles = new Map<string, Promise<string>>();

function embedFontFile(url: string): Promise<string> {
  const cached = embeddedFontFiles.get(url);
  if (cached) return cached;
  const data = fetch(url, { redirect: 'error' }).then(async (response) => {
    if (!response.ok) throw new Error(`Could not load font: ${response.status}`);
    const font = new Blob([await response.arrayBuffer()], { type: 'font/woff2' });
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(font);
    });
  }).catch(() => {
    embeddedFontFiles.delete(url);
    return '';
  });
  embeddedFontFiles.set(url, data);
  return data;
}

function fontNames(families: string): string[] {
  return families.split(',').map((name) => name.trim().replace(/^['"]|['"]$/g, ''));
}

async function fontEmbedCSS(canvas: HTMLElement): Promise<string> {
  const fonts = new Set<string>();
  for (const element of [canvas, ...canvas.querySelectorAll<HTMLElement>('*')]) {
    for (const name of fontNames(getComputedStyle(element).fontFamily)) fonts.add(name);
  }
  const app = new URL(window.location.href);
  const rules: Promise<string>[] = [];
  for (const sheet of document.styleSheets) {
    let cssRules: CSSRuleList;
    try { cssRules = sheet.cssRules; } catch { continue; }
    for (const rule of cssRules) {
      if (!(rule instanceof CSSFontFaceRule) || !fonts.has(fontNames(rule.style.fontFamily)[0])) continue;
      const urls = rule.style.getPropertyValue('src').matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/g);
      const source = [...urls].map((match) => URL.parse(match[1] ?? match[2] ?? match[3], sheet.href ?? document.baseURI))
        .find((url) => url?.protocol === app.protocol && url.host === app.host && /\.woff2$/i.test(url.pathname));
      if (!source) continue;
      const styles = Array.from(rule.style).filter((name) => name !== 'src')
        .map((name) => `${name}:${rule.style.getPropertyValue(name)}`).join(';');
      rules.push(embedFontFile(source.href).then((data) => data ? `@font-face{${styles};src:url("${data}") format("woff2");}` : ''));
    }
  }
  return (await Promise.all(rules)).join('\n');
}

export async function exportGraph(canvas: HTMLElement, format: GraphExportFormat, filename: string, direction: Direction,
  edges: readonly JiraEdge[], parentLabel: string): Promise<void> {
  if (format === 'mermaid') {
    download(new Blob([mermaid(canvas, direction, edges, parentLabel)], { type: 'text/plain;charset=utf-8' }), `${filename}.mmd`);
    return;
  }
  const { toCanvas } = await import('html-to-image');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) throw new Error('Graph viewport is empty.');
  await document.fonts.ready;
  const image = await toCanvas(canvas, {
    width, height, pixelRatio: Math.min(2, 4096 / Math.max(width, height)), fontEmbedCSS: await fontEmbedCSS(canvas),
    style: { overflow: 'hidden' },
    filter: (node) => !(node instanceof Element && node.matches(
      '[data-export-ignore], .react-flow__controls, .react-flow__minimap, .react-flow__attribution',
    )),
  });
  if (format === 'pdf') {
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({
      orientation: width >= height ? 'landscape' : 'portrait', unit: 'px', hotfixes: ['px_scaling'],
      format: [width, height], compress: true,
    });
    pdf.addImage(image, 'PNG', 0, 0, width, height);
    download(pdf.output('blob'), `${filename}.pdf`);
    return;
  }
  const png = await new Promise<Blob | null>((resolve) => image.toBlob(resolve, 'image/png'));
  if (!png) throw new Error('PNG encoding failed.');
  download(png, `${filename}.png`);
}
