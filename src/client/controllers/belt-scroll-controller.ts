import { CollectionService, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { BELT_VISUAL_SPEED_ATTRIBUTE } from "shared/attributes";
import { TAGS } from "shared/tags";
import { BELT_TEXTURE_SCROLL_MULTIPLIER, BELT_TEXTURE_SCROLL_SIGN, BELT_TEXTURE_STUDS_PER_TILE_U } from "shared/tuning";

/**
 * TEMPORARY INSTRUMENTATION. How long the controller waits for the server's `Texture` before giving up
 * loudly, in seconds.
 *
 * Ten seconds is deliberately far longer than server startup and replication should need. The point of
 * the bound is not to be tight — it is to convert an infinite silent wait into one warning, so a
 * missing texture becomes visible in the log rather than only as an absent child in Explorer.
 */
const BELT_TEXTURE_WAIT_SECONDS = 10;

/**
 * Scrolls each belt's surface texture at the belt's own drag speed.
 *
 * ## Why this is on the client
 *
 * `Texture.OffsetStudsU` is a replicated property: writing it on the server every frame would send a
 * property update for every belt on every frame to every client, to produce an effect that every
 * client computes identically from data it already has. The belt's speed is an *attribute*, which is
 * replicated once, so the client can derive the animation from it and send nothing at all. The cost is
 * that a client joining mid-stream starts its phase from whatever offset it reads (zero until the
 * server has never touched it), which is invisible — the pattern is a texture, not a position.
 *
 * The alternative, a `TweenService` loop, was rejected on two grounds: a tween cannot read the live
 * `BeltSpeed` attribute without being rebuilt whenever the attribute changes, and a looping tween's
 * wrap-around from `-n` back to `0` produces a one-frame jump unless the offset is snapped to a tile
 * boundary. Accumulating the offset directly, modulo the tile size, has neither problem.
 *
 * ## Why the offset wraps
 *
 * `OffsetStudsU` is a float; left alone it grows without bound while the game runs, and floats lose
 * precision as magnitude grows. Wrapping at `StudsPerTileU` is exact because the texture is periodic
 * in that interval — offsetting by exactly one tile is visually identical to offsetting by zero. So
 * the value stays in `[0, tile)` forever and precision never degrades.
 */
@Controller()
export class BeltScrollController implements OnStart {
	public onStart(): void {
		const tracked = new Set<BasePart>();
		const textures = new Map<BasePart, Texture>();

		const track = (instance: Instance) => {
			if (!instance.IsA("BasePart")) {
				return;
			}

			tracked.add(instance);

			// The server creates the texture during `bind`, which may run after a client has already
			// received the tag, so a short wait is correct. **It is not an unlimited wait.**
			//
			// TEMPORARY INSTRUMENTATION — "why is there no Texture child?" round. The previous version of
			// this loop was `WaitForChild("BeltSurface")` with no timeout, which never returns if the
			// server's creation failed. That is worse than a crash: the controller waits silently forever,
			// so "the server never made the texture" and "the client hasn't received it yet" are
			// indistinguishable from the outside, and no error is ever printed. A bounded wait that gives
			// up loudly is the whole point of this change to the diagnostic path.
			//
			// The timeout is generous — 10 s — because it is competing with server startup, replication and
			// asset loading on a slow join, and a false "gave up" would be as misleading as the silence it
			// replaces.
			task.spawn(() => {
				const found = instance.WaitForChild("BeltSurface", BELT_TEXTURE_WAIT_SECONDS);
				if (found === undefined) {
					warn(
						`[BeltScroll] GAVE UP waiting ${BELT_TEXTURE_WAIT_SECONDS}s for BeltSurface on "${instance.GetFullName()}" — the server did not create it. No scrolling will happen for this belt.`,
					);
					return;
				}

				if (!found.IsA("Texture")) {
					warn(
						`[BeltScroll] found "${found.GetFullName()}" on "${instance.GetFullName()}" but it is a ${found.ClassName}, not a Texture.`,
					);
					return;
				}

				// Reading the content back is the second half of the diagnostic: a `Texture` whose
				// `ColorMapContent` is empty renders nothing, and an empty value on the client is the
				// expected result of the property being `NotReplicated`. Logging it distinguishes "no
				// texture instance" from "texture instance with no image".
				print(
					`[BeltScroll] found ${found.GetFullName()} on "${instance.GetFullName()}" uri=${tostring(found.ColorMapContent.Uri)} face=${found.Face.Name} tileU=${found.StudsPerTileU} tileV=${found.StudsPerTileV} scrollScale=${BELT_TEXTURE_SCROLL_MULTIPLIER} sign=${BELT_TEXTURE_SCROLL_SIGN}`,
				);
				textures.set(instance, found);
			});
		};

		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			track(instance);
		}

		print(
			`[BeltScroll] controller started, belts tagged ${TAGS.treadmillBelt} found=${CollectionService.GetTagged(TAGS.treadmillBelt).size()} scrollScale=${BELT_TEXTURE_SCROLL_MULTIPLIER} sign=${BELT_TEXTURE_SCROLL_SIGN} tileU=${BELT_TEXTURE_STUDS_PER_TILE_U}`,
		);

		CollectionService.GetInstanceAddedSignal(TAGS.treadmillBelt).Connect(track);
		CollectionService.GetInstanceRemovedSignal(TAGS.treadmillBelt).Connect((instance) => {
			tracked.delete(instance as BasePart);
			textures.delete(instance as BasePart);
		});

		RunService.Heartbeat.Connect((dt) => {
			for (const [belt, texture] of textures) {
				if (!tracked.has(belt) || belt.Parent === undefined) {
					continue;
				}

				// **Only the visual speed.** `BeltSpeedActual` is the ramped scroll rate, published by
				// `TreadmillService.setBeltSpeed`, and it is the one number that may legitimately move while the
				// round spins up. `BeltSpeed` (the reference the `BALL_SPEED` model compares against) is
				// deliberately *not* read here: they were one value for one round, which made every ball drift
				// forward during the ramp with no pickup involved.
				//
				// Absent means zero, not "the designer's number". A belt the round has never driven has no visual
				// speed, and treating a missing attribute as full speed is how a stopped belt scrolls in `Waiting`.
				const visual = belt.GetAttribute(BELT_VISUAL_SPEED_ATTRIBUTE);
				const speed = typeIs(visual, "number") ? visual : 0;

				// Negative speed (a reversed belt) reverses the scroll for free, because the sign of the
				// rate follows the sign of the speed.
				// **The scroll rate is the belt's visual rate times two independent constants**: a multiplier for how fast the
				// tread appears to move and a sign for which way. Neither touches `BeltSpeed`, so the picture can be retimed
				// without changing `RELATIVE_SPEED`, the decay or the race - that is the whole reason the multiplier exists.
				// At `BELT_TEXTURE_SCROLL_MULTIPLIER = 1` this is exactly the expression that shipped before it.
				let offset =
					texture.OffsetStudsU + speed * BELT_TEXTURE_SCROLL_MULTIPLIER * BELT_TEXTURE_SCROLL_SIGN * dt;

				// **Wrapped at the U period, because U is the axis being offset.** The tile is no longer square -
				// `_U` and `_V` differ so the image maps once across the belt - and only the U extent is periodic
				// along the direction `OffsetStudsU` moves, so `_V` has no business appearing in this arithmetic.
				//
				// Double modulo rather than a single one: `%` in Luau keeps the sign of the dividend, so a
				// reversed belt would drift to a negative offset and the wrap would be wrong. Adding the
				// period before the second modulo maps any value into `[0, tile)`.
				offset = offset % BELT_TEXTURE_STUDS_PER_TILE_U;
				if (offset < 0) {
					offset += BELT_TEXTURE_STUDS_PER_TILE_U;
				}

				texture.OffsetStudsU = offset;
			}
		});
	}
}
