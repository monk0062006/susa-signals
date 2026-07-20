import type { Annotation, CaptureDraft, ImageData as CaptureImage, Point } from '@markerio-usa/core';

export type Tool = Annotation['type'];

const COLOR = '#ff3b30';
const Z_INDEX = 2147483000; // just under the u32 max, to sit above host-app modals

/**
 * Screenshot review + annotation UI.
 *
 * Annotations are recorded in normalized 0..1 coordinates so a box drawn on a
 * 390px phone still lands correctly when replayed over a 2x screenshot in the
 * dashboard. Pixel coordinates would silently drift on every rescale.
 */
export class AnnotationOverlay {
  // Declared as `T | undefined` rather than optional (`?:`) so these can be
  // reset to undefined under exactOptionalPropertyTypes.
  private root: HTMLDivElement | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private annotations: Annotation[] = [];
  private tool: Tool = 'rect';
  private drawing = false;
  private start: Point | undefined;
  private penPoints: Point[] = [];

  /** Resolves with the draft, or null if the user cancelled. */
  async present(screenshot: CaptureImage): Promise<CaptureDraft | null> {
    const image = await loadImage(screenshot);

    return new Promise<CaptureDraft | null>((resolve) => {
      this.build(image, resolve);
    });
  }

  private build(image: HTMLImageElement, done: (draft: CaptureDraft | null) => void): void {
    const root = document.createElement('div');
    root.style.cssText = `
      position: fixed; inset: 0; z-index: ${Z_INDEX};
      background: rgba(15,17,21,.82); display: flex; gap: 16px;
      align-items: stretch; padding: 24px; box-sizing: border-box;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #f4f5f7;
    `;

    // --- annotation surface -------------------------------------------------
    const stage = document.createElement('div');
    stage.style.cssText = 'flex:1; display:flex; align-items:center; justify-content:center; min-width:0;';

    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.style.cssText =
      'max-width:100%; max-height:100%; object-fit:contain; border-radius:6px; cursor:crosshair; box-shadow:0 8px 40px rgba(0,0,0,.5);';
    this.canvas = canvas;

    stage.appendChild(canvas);

    // --- side panel ---------------------------------------------------------
    const panel = document.createElement('div');
    panel.style.cssText =
      'width:300px; flex:none; background:#1c1f26; border-radius:10px; padding:18px; display:flex; flex-direction:column; gap:12px; overflow:auto;';

    const tools = document.createElement('div');
    tools.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap;';
    const toolDefs: Array<[Tool, string]> = [
      ['rect', 'Box'],
      ['arrow', 'Arrow'],
      ['pen', 'Pen'],
      ['blur', 'Redact'],
    ];
    const buttons = new Map<Tool, HTMLButtonElement>();

    for (const [tool, label] of toolDefs) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = toolStyle(tool === this.tool);
      btn.onclick = () => {
        this.tool = tool;
        for (const [t, b] of buttons) b.style.cssText = toolStyle(t === tool);
      };
      buttons.set(tool, btn);
      tools.appendChild(btn);
    }

    const title = field('input', 'Title', 'Brief summary of the issue') as HTMLInputElement;
    const description = field('textarea', 'Description', 'Steps to reproduce…') as HTMLTextAreaElement;
    description.rows = 5;

    const hint = document.createElement('p');
    hint.textContent = 'Use Redact to cover any sensitive data before sending.';
    hint.style.cssText = 'margin:0; font-size:12px; color:#8b93a1;';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; gap:8px; margin-top:auto; padding-top:8px;';

    const submit = document.createElement('button');
    submit.textContent = 'Send report';
    submit.style.cssText =
      'flex:1; padding:10px; border:0; border-radius:6px; background:#3b82f6; color:#fff; font-weight:600; cursor:pointer;';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText =
      'padding:10px 14px; border:1px solid #363b45; border-radius:6px; background:transparent; color:#c7ccd6; cursor:pointer;';

    const finish = (draft: CaptureDraft | null): void => {
      document.removeEventListener('keydown', onKey);
      root.remove();
      this.root = undefined;
      done(draft);
    };

    submit.onclick = () => {
      const value = title.value.trim();
      if (!value) {
        // An untitled report is unusable in a triage queue; block rather than guess.
        title.style.borderColor = '#ff3b30';
        title.focus();
        return;
      }
      const draft: CaptureDraft = {
        kind: 'bug',
        title: value,
        annotations: this.annotations,
      };
      const body = description.value.trim();
      if (body) draft.description = body;
      finish(draft);
    };

    cancel.onclick = () => finish(null);

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish(null);
    };
    document.addEventListener('keydown', onKey);

    actions.append(submit, cancel);
    panel.append(tools, title.parentElement as Node, description.parentElement as Node, hint, actions);
    root.append(stage, panel);
    document.body.appendChild(root);
    this.root = root;

    this.bindDrawing(canvas, image);
    this.redraw(image);
    title.focus();
  }

  private bindDrawing(canvas: HTMLCanvasElement, image: HTMLImageElement): void {
    // Pointer events cover mouse, touch and stylus in one code path.
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      this.drawing = true;
      this.start = toNormalized(e, canvas);
      this.penPoints = this.tool === 'pen' && this.start ? [this.start] : [];
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!this.drawing || !this.start) return;
      const current = toNormalized(e, canvas);

      if (this.tool === 'pen') {
        this.penPoints.push(current);
      }
      // Render the in-progress shape without committing it.
      this.redraw(image, this.preview(this.start, current));
    });

    canvas.addEventListener('pointerup', (e) => {
      if (!this.drawing || !this.start) return;
      this.drawing = false;
      const end = toNormalized(e, canvas);

      const shape = this.preview(this.start, end);
      // Ignore stray clicks that produce a zero-area shape.
      if (shape) this.annotations.push(shape);

      this.start = undefined;
      this.penPoints = [];
      this.redraw(image);
    });
  }

  private preview(from: Point, to: Point): Annotation | undefined {
    const w = to.x - from.x;
    const h = to.y - from.y;

    switch (this.tool) {
      case 'rect':
      case 'blur': {
        if (Math.abs(w) < 0.005 || Math.abs(h) < 0.005) return undefined;
        // Normalize so a box dragged up-left still has positive extents.
        const origin = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y) };
        const width = Math.abs(w);
        const height = Math.abs(h);
        return this.tool === 'blur'
          ? { type: 'blur', origin, width, height }
          : { type: 'rect', origin, width, height, color: COLOR };
      }
      case 'arrow':
        if (Math.hypot(w, h) < 0.01) return undefined;
        return { type: 'arrow', from, to, color: COLOR };
      case 'pen':
        if (this.penPoints.length < 2) return undefined;
        return { type: 'pen', points: [...this.penPoints], color: COLOR, strokeWidth: 3 };
      default:
        return undefined;
    }
  }

  private redraw(image: HTMLImageElement, inProgress?: Annotation): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const a of this.annotations) drawAnnotation(ctx, a, canvas);
    if (inProgress) drawAnnotation(ctx, inProgress, canvas);
  }

  /**
   * Flattens annotations into the image. Redactions in particular must be burned
   * in here — shipping the clean screenshot plus a "blur here" instruction would
   * transmit the very data the user asked to hide.
   */
  async flatten(): Promise<CaptureImage> {
    const canvas = this.canvas;
    if (!canvas) throw new Error('Overlay not presented');

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Failed to encode annotated screenshot');

    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height,
    };
  }

  destroy(): void {
    this.root?.remove();
  }
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  canvas: HTMLCanvasElement,
): void {
  const W = canvas.width;
  const H = canvas.height;

  switch (a.type) {
    case 'rect':
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 3;
      ctx.strokeRect(a.origin.x * W, a.origin.y * H, a.width * W, a.height * H);
      break;

    case 'blur': {
      // Solid fill, not a CSS blur: blur is reversible enough to be unsafe for redaction.
      ctx.fillStyle = '#11141a';
      ctx.fillRect(a.origin.x * W, a.origin.y * H, a.width * W, a.height * H);
      break;
    }

    case 'arrow': {
      const x1 = a.from.x * W;
      const y1 = a.from.y * H;
      const x2 = a.to.x * W;
      const y2 = a.to.y * H;
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();

      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = 14;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
      break;
    }

    case 'pen': {
      if (a.points.length < 2) break;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.strokeWidth;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      const [first, ...rest] = a.points;
      ctx.moveTo((first as Point).x * W, (first as Point).y * H);
      for (const p of rest) ctx.lineTo(p.x * W, p.y * H);
      ctx.stroke();
      break;
    }

    case 'text':
      ctx.fillStyle = a.color;
      ctx.font = '600 18px sans-serif';
      ctx.fillText(a.body, a.origin.x * W, a.origin.y * H);
      break;
  }
}

/** Maps a pointer event to 0..1 canvas space, accounting for CSS scaling. */
function toNormalized(e: PointerEvent, canvas: HTMLCanvasElement): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - rect.left) / rect.width),
    y: clamp01((e.clientY - rect.top) / rect.height),
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function loadImage(image: CaptureImage): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([image.bytes as unknown as BlobPart], { type: image.mimeType });
    const url = URL.createObjectURL(blob);
    const el = new Image();
    el.onload = () => {
      URL.revokeObjectURL(url); // object URLs leak until explicitly revoked
      resolve(el);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode screenshot'));
    };
    el.src = url;
  });
}

function toolStyle(active: boolean): string {
  return `padding:7px 12px; border-radius:6px; cursor:pointer; font-size:13px;
    border:1px solid ${active ? '#3b82f6' : '#363b45'};
    background:${active ? '#3b82f6' : 'transparent'};
    color:${active ? '#fff' : '#c7ccd6'};`;
}

function field(tag: 'input' | 'textarea', label: string, placeholder: string): HTMLElement {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:5px; font-size:12px; color:#8b93a1;';
  wrap.textContent = label;

  const el = document.createElement(tag);
  el.placeholder = placeholder;
  el.style.cssText =
    'padding:9px; border-radius:6px; border:1px solid #363b45; background:#12151b; color:#f4f5f7; font:inherit; resize:vertical;';
  wrap.appendChild(el);
  return el;
}
