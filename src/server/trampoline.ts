/**
 * The trampoline's one rule: **may this player bounce right now?**
 *
 * ## Why this is a module rather than a line in the service
 *
 * `TrampolineService` cannot be constructed in Jest - it needs `CollectionService`, a `Touched` signal and a `Player` - so a
 * rule written inside it could only ever be checked by a playtest. This is arithmetic, and the tree's pattern for arithmetic
 * that a service acts on is a plain function beside the service (`round-outcome`, `competitor-slots`, `elimination-signal`,
 * `lateral-shove`), asserted against literals in `src/server/test/trampoline.spec.ts`.
 *
 * ## Why the guard is the whole gate, and why it is short
 *
 * There is no grounded check, no velocity check and no phase check:
 *
 * - **Phase**: a character is only able to walk to a trampoline while `CharacterFreezeController` has it unfrozen, which is
 *   exactly `!cameraWantsArena(phase, competing, spectating)`. A racing body cannot reach the part, so a phase gate here would
 *   be a second copy of a rule that already exists.
 * - **Grounded**: a launch puts the character in the air, and any contact after that is them coming back down - which is
 *   exactly the contact that should launch again. A grounded test would need `Humanoid.FloorMaterial` and would disagree with
 *   the guard the moment the two were retuned apart.
 *
 * So the guard is the only state, and **`TRAMPOLINE_COOLDOWN_SECONDS` is deliberately far shorter than the airtime** - its job
 * is to collapse one landing's burst of `Touched` firings into one launch, not to gate on airtime. An airtime-length guard
 * refuses the landing contact itself, which is item 231's "it sometimes does nothing, then bounces later".
 */
export function canBounce(lastBouncedAt: number | undefined, now: number, cooldown: number): boolean {
	return lastBouncedAt === undefined || now - lastBouncedAt >= cooldown;
}
