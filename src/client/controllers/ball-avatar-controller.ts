import { CollectionService, Players } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import { AVATAR_USER_ID_ATTRIBUTE, OWNER_USER_ID_ATTRIBUTE } from "shared/attributes";
import { avatarUserIdFor } from "shared/ball-avatar";
import { TAGS } from "shared/tags";
import {
	BALL_AVATAR_NAME,
	BALL_AVATAR_OFFSET_STUDS,
	BALL_AVATAR_SIZE,
	BALL_AVATAR_THUMBNAIL_SIZE,
} from "shared/tuning";
import { POWER_BADGE_MAX_DISTANCE } from "shared/powers.config";

/**
 * Puts the owner's face over every ball — **including a `decoy` twin, which wears its parent's.**
 *
 * ## Why this is a client controller and not a line in `updateBadge`
 *
 * The badge is built by the server (`powers/index.ts`), because it is two instances and a string. This is different in kind:
 * `Players:GetUserThumbnailAsync` is a **web call that yields**. On the server that would be a per-player round-trip on the
 * thread that also runs the race, and a round that starts eight bodies would make eight of them at once. On each client it
 * is one request per distinct player, and the result is a `ContentId` the client was going to fetch anyway.
 *
 * ## The three rules, and where each lives
 *
 * 1. **Whose face** — `avatarUserIdFor(OwnerUserId, AvatarUserId)`, in `shared/ball-avatar.ts`, asserted with literals. The
 *    competition key wins, the display key is the twin's fallback, and neither means no face at all.
 * 2. **One request per player, ever** — `thumbnails`, a session cache keyed by `UserId` that also caches *failures*, so a
 *    player whose thumbnail is unavailable is asked for once rather than once per body and per round.
 * 3. **Nothing drawn on failure** — no `Image` is set and no billboard is parented, so a missing thumbnail is an absent
 *    avatar rather than a grey square. The `[BallAvatar]` line names the user id once.
 *
 * ## Why the offset is a constant and not the badge's
 *
 * `BALL_AVATAR_OFFSET_STUDS` sits above `radius + POWER_BADGE_OFFSET_STUDS`, because the badge is already there. It reuses
 * `POWER_BADGE_MAX_DISTANCE` for the far cutoff — that number is a fact about the arena's diagonal, not about badges, and
 * two cutoffs would let the face cull while the name it sits above still draws.
 *
 * ## What it does not touch
 *
 * The red `decoy` outline is `DecoyOutlineController`'s, is owner-only, and stays owner-only: the avatar is the same for
 * everyone precisely because it must give nothing away, and the highlight is the one thing that does.
 */
@Controller()
export class BallAvatarController implements OnStart {
	/**
	 * `UserId` -> thumbnail `ContentId`, or `undefined` for "asked and could not". **A session cache, never per frame.**
	 *
	 * Failures are cached deliberately: a player whose thumbnail is unavailable (a failed web call, a name that resolves to
	 * nothing) would otherwise be re-requested for every body they own in every round, which is the traffic pattern the cache
	 * exists to prevent.
	 */
	private readonly thumbnails = new Map<number, string | undefined>();

	/**
	 * Bodies already given an overlay, so a re-tagged instance does not build a second one.
	 *
	 * The tag signal can fire again for a body that was re-tagged in Studio, and `avatarUserIdFor` is cheap but the fetch
	 * behind it is a web call — this set is what makes "one avatar per body" a fact rather than a hope.
	 */
	private readonly built = new Set<BasePart>();

	public onStart(): void {
		// Existing bodies first: this controller can start after the round's bodies were replicated.
		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			this.observe(instance);
		}

		CollectionService.GetInstanceAddedSignal(TAGS.ball).Connect((instance) => this.observe(instance));

		// A destroyed body takes its overlay with it, so the only cleanup is the bookkeeping entry — leaving it would make a
		// later body that reused the table slot look already-built.
		CollectionService.GetInstanceRemovedSignal(TAGS.ball).Connect((instance) => {
			if (instance.IsA("BasePart")) {
				this.built.delete(instance);
			}
		});

		print(`[BallAvatar] watching ${TAGS.ball} bodies size=${BALL_AVATAR_SIZE} offset=${BALL_AVATAR_OFFSET_STUDS}`);
	}

	/** Resolves who a body is drawn as, and kicks off the fetch for it. Synchronous and cheap: the call is spawned. */
	private observe(instance: Instance): void {
		if (!instance.IsA("BasePart") || this.built.has(instance)) {
			return;
		}

		const userId = avatarUserIdFor(
			instance.GetAttribute(OWNER_USER_ID_ATTRIBUTE),
			instance.GetAttribute(AVATAR_USER_ID_ATTRIBUTE),
		);

		if (userId === undefined) {
			return;
		}

		this.built.add(instance);
		task.spawn(() => this.attach(instance, userId));
	}

	/**
	 * Fetches the face, then hangs it on the body — **in that order**, so a body that dies during the web call never gets a
	 * billboard and no empty frame is ever parented.
	 */
	private attach(body: BasePart, userId: number): void {
		const image = this.thumbnailFor(userId);

		// Two checks after a yielding call, and both are needed: `Parent` catches a body destroyed while the request was in
		// flight (the round ended, the cap evicted it, the kill plane took it), and the size read below has to happen on a live
		// part because a destroyed one returns defaults.
		if (image === undefined || body.Parent === undefined) {
			return;
		}

		const overlay = new Instance("BillboardGui");
		overlay.Name = BALL_AVATAR_NAME;
		overlay.Adornee = body;
		overlay.AlwaysOnTop = true;
		overlay.LightInfluence = 0;
		overlay.Size = UDim2.fromOffset(BALL_AVATAR_SIZE, BALL_AVATAR_SIZE);
		overlay.MaxDistance = POWER_BADGE_MAX_DISTANCE;
		// **A studs offset above the radius, exactly like the badge** — a fixed number without the radius is what buried the
		// badge when the ball grew to 20 studs, and the face has the same body under it.
		overlay.StudsOffset = new Vector3(0, body.Size.Y / 2 + BALL_AVATAR_OFFSET_STUDS, 0);

		const face = new Instance("ImageLabel");
		face.Name = "Face";
		face.Size = UDim2.fromScale(1, 1);
		face.BackgroundTransparency = 1;
		face.Image = image;
		face.ScaleType = Enum.ScaleType.Fit;
		face.Parent = overlay;

		overlay.Parent = body;
	}

	/**
	 * The cached `ContentId` for a player, fetching it the first time and **never asking twice.**
	 *
	 * `pcall` rather than a bare call because `GetUserThumbnailAsync` is a web call and can throw; one player's failure must
	 * not take the overlay down for everyone else in the round. The empty string is Roblox's "no image" answer and is treated
	 * as a failure rather than as an image, for the reason the whole overlay has a "draw nothing" branch: an `ImageLabel`
	 * pointed at `""` renders a grey square.
	 */
	private thumbnailFor(userId: number): string | undefined {
		if (this.thumbnails.has(userId)) {
			return this.thumbnails.get(userId);
		}

		const [ok, thumbnail] = pcall(() =>
			Players.GetUserThumbnailAsync(userId, Enum.ThumbnailType.HeadShot, BALL_AVATAR_THUMBNAIL_SIZE),
		);

		const image = ok && typeIs(thumbnail, "string") && thumbnail !== "" ? thumbnail : undefined;
		this.thumbnails.set(userId, image);

		if (image === undefined) {
			// **Once per `UserId`**, which is what the cache guarantees: a player with four bodies across five rounds is one
			// line, and the reason a face is missing is in the log rather than inferred from a bare ball.
			warn(`[BallAvatar] no thumbnail userId=${userId} — that player's balls will show no face this session.`);
		} else {
			print(`[BallAvatar] thumbnail userId=${userId} image=${image}`);
		}

		return image;
	}
}
