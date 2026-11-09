export interface SpriteSheet {
  readonly image: CanvasImageSource & {
    readonly width: number;
    readonly height: number;
  };
  readonly frameWidth?: number;
  readonly frameHeight?: number;
}

// Малює кадр зі спрайт-листа (кадри лежать в одному рядку).
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  sheet: SpriteSheet,
  frame: number,
  size: number,
): void {
  const { image, frameWidth = image.width, frameHeight = image.height } = sheet;
  ctx.drawImage(
    image,
    frame * frameWidth,
    0,
    frameWidth,
    frameHeight,
    -size / 2,
    -size / 2,
    size,
    size * (frameHeight / frameWidth),
  );
}
