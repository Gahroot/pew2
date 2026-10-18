/**
 * Whether the home screen's recent-chats row fits above the composer.
 *
 * Pure, so `bun test` can load it. The home block (Pew, the status line, the
 * greeting, the hint and the row) is centred in the conversation body, and the
 * composer is drawn over that body's bottom edge. On a short phone (an iPhone SE)
 * the centred row ended up underneath the composer's project chip and blur. When
 * it would, the row is left out rather than the block being squeezed. The chats
 * are still in the drawer.
 */

/**
 * The tallest the home block can be and, centred in the body, still end `gap`
 * above the composer.
 *
 * @param bodyHeight The body the block is centred in. Zero means not yet measured.
 * @param bottomClearance How much of the body's bottom the composer covers.
 * @param gap The space kept between the block and the composer.
 * @returns undefined until the body has been measured.
 */
export function homeMaxHeight(
  bodyHeight: number,
  bottomClearance: number,
  gap: number,
): number | undefined {
  if (bodyHeight <= 0) return undefined;
  // Centred, the block's bottom edge is at (body + block) / 2, which has to stay
  // at or above body - clearance - gap.
  return bodyHeight - 2 * (bottomClearance + gap);
}

/**
 * Whether the row fits under the rest of the block.
 *
 * Decided from the block *without* the row, which stays the same size whether
 * or not the row is drawn, so the answer can't flip back and forth as the row
 * comes and goes. Until anything is measured the row is kept, which is the
 * answer on every phone but the shortest. Those re-centre once, during the
 * block's fade-in.
 *
 * @param coreHeight The block's height without the row. Zero means not yet measured.
 * @param rowHeight The row's height, including its space above.
 * @param maxHeight From `homeMaxHeight`. Undefined keeps the row.
 */
export function recentChatsFit(
  coreHeight: number,
  rowHeight: number,
  maxHeight: number | undefined,
): boolean {
  if (maxHeight === undefined || coreHeight <= 0) return true;
  return coreHeight + rowHeight <= maxHeight;
}
