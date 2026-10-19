// Малює кадр зі спрайт-листа (кадри лежать в одному рядку).
export function drawFrame(ctx, sheet, frame, size) {
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
