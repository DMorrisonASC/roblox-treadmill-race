import { CollectionService, Players, RunService } from "@rbxts/services";
import { Controller, OnStart } from "@flamework/core";
import {
	MARKER_LOCAL_POSITION_ATTRIBUTE,
	MARKER_LOCAL_RIGHT_ATTRIBUTE,
	MARKER_LOCAL_UP_ATTRIBUTE,
} from "shared/attributes";
import { BALL_SPEED_ATTRIBUTE } from "shared/attributes";
import { TAGS } from "shared/tags";
import { apparentSpinRate } from "shared/apparent-spin";
import {
	APPARENT_SPIN_SIGN,
	APPARENT_SPIN_SMOOTHING_SECONDS,
	BALL_PHANTOM_NAME,
	SPIN_DEADBAND_SPEED,
} from "shared/tuning";

/** One marker and the pose it holds relative to its body, read once when the marker is first seen. */
interface TrackedMarker {
	readonly marker: BasePart;
	readonly localFrame: CFrame;
}

/**
 * Per-body spin state, shared by all three of that body's markers.
 *
 * Deliberately keyed by body rather than by marker: the rotation is a property of the ball, and three
 * markers each accumulating their own angle would drift apart within a second of spawn (they would
 * differ by whatever `|Δposition|` noise each happened to see). One angle, three applications.
 */
interface BodySpin {
	readonly body: BasePart;
	readonly radius: number;
	markers: Array<TrackedMarker>;
	/** Smoothed world-space velocity, in studs/s. Smoothed as a vector — see the smoothing constant. */
	velocity: Vector3;
	/** Accumulated world-space rotation, applied about the body's centre. */
	spin: CFrame;
	/** Position last frame, used to measure the displacement this frame. */
	lastPosition: Vector3;
	/** TEMPORARY INSTRUMENTATION. Total radians accumulated, so the log shows progress, not just rate. */
	angle: number;
	/** TEMPORARY INSTRUMENTATION. Whether the rejected-write warning has fired for this body. */
	writeWarned: boolean;
	/** TEMPORARY INSTRUMENTATION. Whether the once-per-body ownership line has printed. */
	ownerLogged: boolean;
	/** Frames since `spin` was last re-orthonormalised; see the guard in the frame loop. */
	framesSinceNormalize: number;
	/**
	 * The `BallRenderController` skin for this body, cached so the lookup is not per frame.
	 *
	 * When it exists, the markers are posed **inside its frame** and this controller accumulates no angle of its own:
	 * one rotation, computed once, so the skin and the markers cannot drift apart. `undefined` until the first frame
	 * after the phantom replicates ? and permanently on a client where that controller has failed, which is why the
	 * spin path below survives as the fallback rather than as dead code.
	 */
	phantom?: BasePart;
}

/**
 * TEMPORARY INSTRUMENTATION. How many `discovered` lines a session may print.
 *
 * The prompt asks for one line per marker, which is three per body; at the 50-body cap that would be
 * 150 lines burying everything else, so the trace is capped at ten bodies' worth. Twelve is the number
 * the acceptance criterion actually needs (four bodies), thirty leaves room for a manual `1` press on
 * top of the round's spawn without becoming the new noise floor.
 */
const DISCOVERY_LOG_LIMIT = 30;

/**
 * TEMPORARY INSTRUMENTATION. How many frames of boot trace print after the first marker is discovered.
 *
 * A frame count, not a duration, deliberately: the question is whether the per-frame pipeline runs at
 * all and what it computes on its first passes, and a duration would sample that pipeline at whatever
 * rate the machine happened to hit. Thirty frames is half a second at 60 Hz — long enough to see the
 * smoothed velocity leave zero and the accumulated angle start moving, short enough to stay a boot
 * trace rather than a sampler.
 */
const BOOT_TRACE_FRAMES = 30;

/**
 * **Placeholder.** Seconds after the first ball appears before the controller declares discovery dead.
 *
 * The same discipline item 13 applied to `BeltScrollController`'s `WaitForChild`: an unbounded wait is
 * indistinguishable from "not replicated yet", and the symptom it produces — a controller that started
 * cleanly and then does nothing — is exactly the one this round exists to make impossible to reproduce
 * silently. Ten seconds is generous against a marker that should arrive within a frame of its body
 * (the observed gap was 33 ms), and short enough that a failure is still in the log the reader is
 * looking at.
 */
const MARKER_SPIN_DISCOVERY_TIMEOUT_SECONDS = 10;

/**
 * TEMPORARY INSTRUMENTATION. Cadence of the steady-state diagnostic line, in seconds.
 *
 * One second is slow enough to leave the belt and round lines readable and fast enough that the belt
 * ramp (3 s) produces three samples: a speed that reads zero for the ramp and then climbs is a
 * different fault from a speed that reads zero throughout.
 */
const STATE_LOG_INTERVAL_SECONDS = 1;

/**
 * TEMPORARY INSTRUMENTATION. Total steady-state lines the session may print.
 *
 * Twelve covers the ramp and several seconds of running. **The budget is only spent when a body is
 * actually tracked** — see the guard in the frame loop. The previous build spent all twelve during the
 * 108 seconds between controller start and the first spawn, which is why a run that discovered markers
 * correctly still reported nothing about them. That was a defect in the logging, not the controller.
 */
const STATE_LOG_LIMIT = 12;

/**
 * Frames between re-orthonormalisations of a ball's accumulated spin rotation.
 *
 * 300 frames is five seconds at 60 Hz. See the guard in the frame loop: while a ball is moving the
 * velocity branch multiplies the rotation every frame, and without this the basis drifts off
 * orthonormal over a long session and starts moving markers off the sphere's surface.
 */
const NORMALIZE_SPIN_EVERY_FRAMES = 300;

/**
 * TEMPORARY INSTRUMENTATION. How often the tag is re-walked for markers the signal did not deliver.
 *
 * Half a second, not a frame: this is a repair path for a missed event, not a polling loop. It is also
 * short enough that a marker missed at spawn is picked up before the ball has travelled far, so the
 * visible symptom is a brief hesitation rather than a marker left at the start line.
 */
const TRACK_RESCAN_SECONDS = 0.5;

/** TEMPORARY INSTRUMENTATION. Three decimals, matching the server's formatter. */
function describeNumber(value: number): string {
	return tostring(math.round(value * 1000) / 1000);
}

/** TEMPORARY INSTRUMENTATION. A `Vector3` as `(x, y, z)`, so a position stays greppable on one line. */
function describeVector(value: Vector3): string {
	return `(${describeNumber(value.X)}, ${describeNumber(value.Y)}, ${describeNumber(value.Z)})`;
}

/**
 * TEMPORARY INSTRUMENTATION. Who owns a body, rendered so the answer fits in a log field.
 *
 * **`GetNetworkOwner` is a server-only call** and raises on a client that does not own the body. It used to
 * succeed here only because the local player owned the balls; with the ball spawned server-owned (`auto=true`)
 * it throws, and because the call sat *before* the marker was registered, the throw aborted `track()` and no
 * marker was ever tracked. Wrapped so the answer degrades to `unreadable(client)` instead of taking the caller
 * down with it.
 */
function describeNetworkOwner(body: BasePart): string {
	const [ok, owner] = pcall(() => body.GetNetworkOwner());
	if (!ok) {
		return "unreadable(client)";
	}

	return typeIs(owner, "Instance") ? owner.Name : "server";
}

/**
 * Draws each ball's three visual markers spinning faster than the ball physically spins.
 *
 * ## Why a marker rate that is not the physical rate is not a lie
 *
 * A `Part` with `Shape = Ball` has no surface, so its own rotation is invisible: the markers *are* the
 * ball's visible rotation. The belt as built produces a body whose physical spin is **zero** — the
 * `[Spawner] spin-probe` lines report `|omega| = 0` and `contactSlip = 10` on every probe, i.e. the
 * ball slides. True spin is therefore not merely slow, it is absent, so any rate derived from it is
 * absent too. The markers are re-rated from "a physical feature of the ball" to "an indicator drawn on
 * the ball" — a speedometer is not a wheel — and the rate scales from the ball's *translation* until
 * real spin exists: `gain x |v| / radius` while moving, `0` below a deadband, and the ball's own
 * rotation instead of its translation once the belt actually imparts one.
 *
 * **What is lost, named up front:** a sliding ball and a rolling ball look the same in *kind*, because a
 * sliding ball's rate is the rate it would have if it were rolling. They differ only once real spin
 * appears, at which point the physical branch takes over. The diagnostic survives as text:
 * `[Spawner] spin-probe` in `BallSpawnerService` reports the body's real `|omega|` and `contactSlip`
 * once per body. Writing `AssemblyAngularVelocity` to make the picture agree with the physics was
 * rejected — that would turn a display decision into a physics change and would corrupt the experiment
 * the whole belt exists to run.
 *
 * ## Why this runs on the client, and why the markers are anchored
 *
 * `BasePart.CFrame` writes are local to the client that makes them. That is only *stable* when the
 * server does not also write the property: a client write to a property the server keeps updating is
 * overwritten on the next replication. So the server anchors each marker at spawn and never touches it
 * again (`BallSpawnerService.createMarker`), leaving the property uncontended, and this controller owns
 * it from then on. The same reasoning is why the weld was removed rather than broken on the client: an
 * unanchored, server-simulated part's `CFrame` is re-derived by the physics solver, so a local write to
 * it wins only by accident.
 *
 * ## Why the speed comes from `CFrame` delta and not `AssemblyLinearVelocity`
 *
 * `AssemblyLinearVelocity` is tagged **NotReplicated** in the installed typings, so a client has no
 * replicated copy of it in the property sense — the value is maintained locally by whichever machine
 * simulates the assembly. The position delta is the client's own observation of how fast the ball
 * *appears* to move, and it is read alongside the property and the larger of the two is used: the
 * delta is quantised to the physics step and reads exactly zero on a frame where no step landed, and
 * the property can be stale on a client that does not own the body, so each covers the other's failure.
 *
 * **This velocity now does two jobs, neither of which is "the rate".** It provides the fallback axis when
 * the body has no physical spin, and its smoothed magnitude is the input to the velocity branch of the
 * rate. The rate itself is chosen by the three-branch model in the frame loop.
 */
@Controller()
export class MarkerSpinController implements OnStart {
	public onStart(): void {
		const bodies = new Map<BasePart, BodySpin>();
		// Every marker currently in `bodies`, so a rescan or a repeated added-signal for the same marker
		// cannot push it twice. Without this, one marker registered twice is written twice per frame with
		// the same pose (harmless) but also survives an `untrack` for the other copy (not harmless: the
		// entry stays alive after its body is gone, which is the leak this class exists to avoid).
		const trackedMarkers = new Set<BasePart>();
		const connections = new Array<RBXScriptConnection>();
		let discoveryLogCount = 0;
		let bootFramesRemaining = -1;
		let stateLogCount = 0;
		let emptyStateLogged = false;
		let nextStateLogAt = os.clock() + STATE_LOG_INTERVAL_SECONDS;
		let firstBallSeenAt: number | undefined;
		let discoveryTimedOut = false;

		/**
		 * Starts the discovery clock the first time a body carrying `TAGS.ball` is seen.
		 *
		 * Measured from the first ball rather than from `onStart` on purpose: in a normal session the
		 * controller starts long before anything spawns — 108 seconds in the log this round answers — so a
		 * timeout measured from `onStart` would expire long before there was anything to discover and report
		 * a failure that had not happened. The clock only runs once there is something to find.
		 */
		const noteBall = (instance: Instance) => {
			if (firstBallSeenAt === undefined && instance.IsA("BasePart") && instance.HasTag(TAGS.ball)) {
				firstBallSeenAt = os.clock();
			}
		};

		const track = (instance: Instance) => {
			if (!instance.IsA("BasePart") || trackedMarkers.has(instance)) {
				return;
			}

			const body = instance.Parent;
			const bodyIsBall = body !== undefined && body.IsA("BasePart") && body.HasTag(TAGS.ball);

			// **Printed before the guard, and that ordering is the point.** This is the line the diagnosis
			// hangs on. If the tag name were wrong, or a marker were parented somewhere unexpected, the guard
			// below would return and the only visible symptom would be a controller that started and then did
			// nothing — the exact ambiguity this round exists to remove. Reporting the observed relationship
			// whether or not it is usable means one line settles it either way, which is why
			// `bodyTaggedBall=false` is a printable outcome rather than a silent one.
			if (discoveryLogCount < DISCOVERY_LOG_LIMIT) {
				discoveryLogCount++;
				const localPosition = instance.GetAttribute(MARKER_LOCAL_POSITION_ATTRIBUTE);
				print(
					`[MarkerSpin] discovered ${instance.GetFullName()} body=${body === undefined ? "none" : body.GetFullName()} bodyTaggedBall=${tostring(bodyIsBall)} localPos=${typeIs(localPosition, "Vector3") ? describeVector(localPosition) : "missing"}`,
				);
			}

			if (!bodyIsBall) {
				// A decoration that is not a child of a ball is not drawable: the whole construction is
				// `body.CFrame * spin * localFrame`, and there is no body. Warn rather than silently
				// ignoring it, because the only way to get here is a scene or code change that broke the
				// parent-of-a-ball invariant, and silence would leave the marker parked at spawn forever.
				warn(
					`[MarkerSpin] "${instance.GetFullName()}" is tagged ${TAGS.ballDecoration} but its parent is not a ${TAGS.ball}-tagged part; it will not spin.`,
				);
				return;
			}

			const localFrame = readLocalFrame(instance);
			if (localFrame === undefined) {
				// Happens for a marker created by a build that predates the attributes, or if replication
				// reordered child creation ahead of attribute replication. The offset cannot be recovered
				// on the client (the body has moved since spawn), so the honest response is one warning and
				// no drawing, rather than placing the marker somewhere plausible and wrong.
				warn(
					`[MarkerSpin] "${instance.GetFullName()}" has no ${MARKER_LOCAL_POSITION_ATTRIBUTE}/${MARKER_LOCAL_RIGHT_ATTRIBUTE}/${MARKER_LOCAL_UP_ATTRIBUTE} attributes; it will not spin.`,
				);
				return;
			}

			let state = bodies.get(body);
			if (state === undefined) {
				state = {
					body,
					// The pool is a singleton sphere (item 12), so `Size.Y` is the diameter and half of it is
					// the radius. `Size.Y` rather than `Size.X` because the vertical half-extent is what the
					// rolling geometry actually uses, and a future non-sphere entry would be wrong here
					// either way — at which point this needs the same treatment `rotatedHalfHeight` got.
					radius: body.Size.Y / 2,
					markers: new Array<TrackedMarker>(),
					velocity: Vector3.zero,
					spin: new CFrame(),
					lastPosition: body.Position,
					angle: 0,
					writeWarned: false,
					ownerLogged: false,
					framesSinceNormalize: 0,
					phantom: undefined,
				};
				bodies.set(body, state);
			}

			// TEMPORARY INSTRUMENTATION. One line per body, once, at the moment it starts being drawn.
			//
			// Not diagnosis — a bookmark. The rate model reads `AssemblyAngularVelocity`, and on a client that
			// does not own the body that property may be stale or zero, so "why does this client draw the
			// sliding rate instead of the real spin" is a question that will come up again. The answer is
			// decided by who owned the body, and that fact is only available here, at the moment of first
			// draw. One line per body means the question is answerable from any future log without
			// re-litigating it or adding a second round of instrumentation to find out.
			if (!state.ownerLogged) {
				state.ownerLogged = true;
				print(
					`[MarkerSpin] owner body="${body.GetFullName()}" owner=${describeNetworkOwner(body)} localPlayer=${Players.LocalPlayer?.Name ?? "none"} |omegaPhysical|=${describeNumber(body.AssemblyAngularVelocity.Magnitude)} |v|=${describeNumber(body.AssemblyLinearVelocity.Magnitude)}`,
				);
			}

			trackedMarkers.add(instance);
			state.markers.push({ marker: instance, localFrame });

			// The boot trace begins with the *first* marker that is actually usable, not with the first that
			// is merely seen: a stream of `bodyTaggedBall=false` markers would otherwise start a 30-frame
			// trace that could never print anything about spin.
			if (bootFramesRemaining < 0) {
				bootFramesRemaining = BOOT_TRACE_FRAMES;
			}
		};

		const untrack = (instance: Instance) => {
			if (!instance.IsA("BasePart")) {
				return;
			}

			for (const [body, state] of bodies) {
				const remaining = state.markers.filter((entry) => entry.marker !== instance);
				if (remaining.size() === state.markers.size()) {
					continue;
				}

				// The body entry is dropped only when its last marker goes, so a marker untagged on its own
				// does not throw away the accumulated angle the other two are still using.
				trackedMarkers.delete(instance);
				if (remaining.size() === 0) {
					bodies.delete(body);
				} else {
					state.markers = remaining;
				}
				return;
			}

			// Nothing matched: the marker was never tracked (its body was already gone when it arrived), so
			// clearing it here is what keeps the set from retaining a destroyed instance.
			trackedMarkers.delete(instance);
		};

		for (const instance of CollectionService.GetTagged(TAGS.ballDecoration)) {
			track(instance);
		}

		for (const instance of CollectionService.GetTagged(TAGS.ball)) {
			noteBall(instance);
		}

		print(
			`[MarkerSpin] controller started, markers tagged ${TAGS.ballDecoration} found=${CollectionService.GetTagged(TAGS.ballDecoration).size()}`,
		);

		// ## The two discovery paths, and why both are kept
		//
		// The tag signal is the primary path and the one that works: the log this round answers shows three
		// markers discovered 33 ms after the round's bodies spawned, i.e. within a frame of the server
		// parenting them. The startup scan above is *not* a substitute for it — at `onStart` the client has
		// not received the scene at all (the belt controller reports the same `found=0` two seconds before
		// the belt itself replicates), so it can only ever catch the reconnect case where the server has
		// already spawned.
		//
		// The periodic rescan is kept because the two together leave no ordering in which a marker is
		// silently never drawn, and because `track` is idempotent through `trackedMarkers`. It also now
		// carries the discovery timeout below, so it has a job even when discovery succeeds.
		connections.push(CollectionService.GetInstanceAddedSignal(TAGS.ballDecoration).Connect(track));
		connections.push(CollectionService.GetInstanceRemovedSignal(TAGS.ballDecoration).Connect(untrack));
		connections.push(CollectionService.GetInstanceAddedSignal(TAGS.ball).Connect(noteBall));

		task.spawn(() => {
			while (true) {
				task.wait(TRACK_RESCAN_SECONDS);

				for (const instance of CollectionService.GetTagged(TAGS.ballDecoration)) {
					track(instance);
				}

				// TEMPORARY INSTRUMENTATION. The bounded wait item 13 landed for `BeltScrollController`, applied
				// here to a different wait: not for a child that may never arrive, but for a *tag* that may
				// never replicate. Same defect, same treatment — a silent infinite wait is indistinguishable
				// from "it will arrive next frame", and the user-visible symptom of both is a ball with no
				// spin and no log line saying why.
				if (
					!discoveryTimedOut &&
					trackedMarkers.size() === 0 &&
					firstBallSeenAt !== undefined &&
					os.clock() - firstBallSeenAt >= MARKER_SPIN_DISCOVERY_TIMEOUT_SECONDS
				) {
					discoveryTimedOut = true;
					warn(
						`[MarkerSpin] GAVE UP waiting for ${TAGS.ballDecoration} ${MARKER_SPIN_DISCOVERY_TIMEOUT_SECONDS}s after the first ${TAGS.ball}: markers seen=${CollectionService.GetTagged(TAGS.ballDecoration).size()} tracked=0. Check the tag string and that the markers are children of a ${TAGS.ball}-tagged body.`,
					);
				}
			}
		});

		// ## Teardown
		//
		// Flamework v5.9.3 exposes `OnInit`, `OnStart`, `OnTick`, `OnPhysics` and `OnRender` — verified in
		// `@flamework/core/out/flamework.d.ts`, **there is no `OnStop`**, so there is no controller teardown
		// hook to hang this on. `game.Destroying` is the hook that does exist, and it is honest about its
		// own limits: in Studio a stop tears down the entire client DataModel, which already takes every
		// connection and the controller's captured state with it, so this disconnect is belt-and-braces
		// rather than load-bearing. It is here because the *next* thing added to this class might own
		// something that outlives the DataModel tree (a thread, a cache), and a single place that drops
		// everything is cheaper to keep correct than an argument about which leaks are reachable.
		connections.push(
			game.Destroying.Connect(() => {
				for (const connection of connections) {
					connection.Disconnect();
				}

				trackedMarkers.clear();
				bodies.clear();
			}),
		);

		// `RenderStepped` rather than `Heartbeat`: these are rendered poses and nothing else reads them,
		// so they must be written after the physics for the frame has been applied and before the frame
		// is drawn. On `Heartbeat` the markers would lag the ball by a frame, which at belt speed is a
		// visible separation between the markers and the sphere they are supposed to be painted on.
		RunService.RenderStepped.Connect((dt) => {
			// A zero or nil delta happens on the first frame after a long stall, and dividing by it would
			// produce an infinite velocity that the smoothing then takes hundreds of frames to forget.
			const frameDt = dt > 0 ? dt : 1 / 60;

			// TEMPORARY INSTRUMENTATION. Chosen once per logging interval, before the loop, so the line
			// describes the same body it reports on even if the map mutates underneath it this frame.
			const now = os.clock();
			let sample: BodySpin | undefined;
			let traceThisFrame = false;

			if (bootFramesRemaining > 0) {
				// The boot trace outranks the steady-state line: for the first 30 frames after discovery the
				// question is "does the pipeline run at all", and the per-second line answers it too slowly.
				traceThisFrame = true;
				bootFramesRemaining--;
			}

			// **The budget is only spent when there is a body to report on.** The previous build decremented
			// it while `bodies` was empty, and since the client sits idle for over a minute before a round
			// starts, all twelve lines were consumed reporting `bodies=0` — which is why a run that
			// discovered every marker still said nothing about them. Empty-state lines are now printed the
			// first time and then suppressed, so the count means "lines about a real body".
			if (stateLogCount < STATE_LOG_LIMIT && now >= nextStateLogAt) {
				nextStateLogAt = now + STATE_LOG_INTERVAL_SECONDS;

				if (bodies.size() > 0) {
					stateLogCount++;
					if (!traceThisFrame) {
						for (const [, candidate] of bodies) {
							sample = candidate;
							break;
						}
					}
				} else if (!emptyStateLogged) {
					// Printed **once**, not once a second. The first draft tested `stateLogCount === 0` here,
					// which never advances because the empty branch does not spend the budget — so it repeated
					// every second for the 108 s the client sits idle, which is the flood pattern this whole
					// convention exists to avoid.
					emptyStateLogged = true;
					print(
						`[MarkerSpin] state bodies=0 tracked=0 tagged=${CollectionService.GetTagged(TAGS.ballDecoration).size()} — no markers have reached this client yet`,
					);
				}
			}

			if (traceThisFrame && sample === undefined) {
				for (const [, candidate] of bodies) {
					sample = candidate;
					break;
				}
			}

			for (const [body, state] of bodies) {
				// The one sweep that makes this leak-free. Balls die by cap eviction, by the kill plane and
				// by round teardown; in every case the body's `Parent` becomes nil and its markers are
				// destroyed as children. The `GetInstanceRemovedSignal` above usually fires for those, but
				// relying on it alone would leave a per-body entry alive for any destruction path that does
				// not raise it — and this map would then grow for the whole session, at spawn rate.
				if (body.Parent === undefined) {
					bodies.delete(body);
					continue;
				}

				const position = body.Position;
				const deltaVelocity = position.sub(state.lastPosition).mul(1 / frameDt);
				state.lastPosition = position;

				// **Two sources, because either can be degenerate and they describe the same motion.**
				//
				// `AssemblyLinearVelocity` is tagged `NotReplicated` in the typings, which is why the first
				// version of this controller refused to read it — but that tag governs *property*
				// replication, not the physics stream: the value is maintained locally by whichever machine
				// simulates the assembly. In this scene that is the client (`describeOwner` reports
				// `owner=<player>` on the ball), so the reading is the client's own simulation and is the
				// smoothest available. The position delta is the fallback and the cross-check: it needs no
				// property at all, but it is quantised to the physics step, so on a frame where no step
				// landed it reads exactly zero.
				//
				// Taking the larger magnitude rather than preferring one is deliberate. Both are estimates
				// of the same velocity, and the failure mode of each is *under*-reporting (a stale property,
				// or a step that has not arrived); the larger is therefore the one that is not degenerate.
				// Over-reporting is bounded by the smoothing below, which is what the time constant is for.
				const replicatedVelocity = body.AssemblyLinearVelocity;
				const currentVelocity =
					replicatedVelocity.Magnitude >= deltaVelocity.Magnitude ? replicatedVelocity : deltaVelocity;
				const source = replicatedVelocity.Magnitude >= deltaVelocity.Magnitude ? "velocity" : "delta";

				// Exponential smoothing toward the observed velocity: `alpha` is the fraction of the way to
				// the new value this frame, derived from the time constant rather than fixed, so the
				// smoothing behaves the same at any frame rate.
				const alpha = 1 - math.exp(-frameDt / APPARENT_SPIN_SMOOTHING_SECONDS);
				state.velocity = state.velocity.add(currentVelocity.sub(state.velocity).mul(alpha));

				// The smoothed world velocity is still needed for one thing only: the `|v|` field of the log
				// line, which is the cross-check against `BALL_SPEED`. It is no longer the rate (see `ballSpeed`)
				// and no longer the axis (see the axis note below).

				// **The spin rate comes from `BALL_SPEED`, not from the world velocity.**
				//
				// This is the same class of bug item 43 fixed for the drift sign, one layer up. Under the
				// reference-speed model a ball's world velocity is `RELATIVE_SPEED = BALL_SPEED - BELT_SPEED`,
				// so at spawn it is **zero** and during a normal ride it is a small negative number. Driving the
				// markers from `|v|` therefore drew a ball that visually sat still with no rotation, then a ball
				// that slowly rotated *backwards* as it lost ground - as if it were sliding on a stationary floor.
				//
				// The ball is not on a stationary floor. It is rolling on a surface moving at `BELT_SPEED`, and
				// relative to that surface its speed is `BALL_SPEED`. That is the number the markers should show:
				// fast at spawn, slowing as the attribute decays, jumping on a pickup. The rate is therefore
				// always positive and the markers always turn forward - there is no backward case any more.
				//
				// A missing attribute reads as `0`, which yields the deadband and holds the markers still. That is
				// the correct answer for a body with no `BALL_SPEED` rather than a guess, and `BALL_SPEED` cannot be
				// `NaN`: every writer is `math.max(0, ...)` or a constant.
				const rawBallSpeed = body.GetAttribute(BALL_SPEED_ATTRIBUTE);
				const ballSpeed = typeIs(rawBallSpeed, "number") && rawBallSpeed === rawBallSpeed ? rawBallSpeed : 0;

				// **Item 98: the skin owns the roll, the markers ride inside its frame.** `BallRenderController` builds one
				// `BALL_PHANTOM_NAME` part per body and rolls it about the belt's spin axis; posing the markers inside that same
				// `CFrame` is what keeps the six face textures and the three markers turning together. Two independent
				// accumulations of the same rate would drift apart within a second of spawn, which is the failure the one-angle
				// rule at the top of this file exists to prevent.
				//
				// Cached on the state rather than looked up every frame, and re-resolved when the cached part has gone (a
				// re-spawned body under the same tag, or a client-side clear). `undefined` means "this client has no skin", and
				// the spin path below then runs exactly as it did before item 98 ? the markers still turn, in the ball's own
				// frame, which is degraded but not frozen.
				let phantom = state.phantom;
				if (phantom !== undefined && phantom.Parent === undefined) {
					phantom = undefined;
				}

				if (phantom === undefined) {
					const found = body.FindFirstChild(BALL_PHANTOM_NAME);
					phantom = found !== undefined && found.IsA("BasePart") ? found : undefined;
				}

				state.phantom = phantom;
				// TEMPORARY INSTRUMENTATION. Hoisted so the log lines can report the rate actually applied
				// this frame, which of the three axis sources produced it, and which branch set the rate.
				let omegaThisFrame = 0;
				let axisSource = "none";
				let rateSource = "deadband";

				// ## The model, and why it is one branch now
				//
				// The rate is `min(MAX, APPARENT_SPIN_GAIN x BALL_SPEED / radius)`, or `0` below
				// `SPIN_DEADBAND_SPEED`. That is the whole thing.
				//
				// Earlier versions chained branches: a physical-spin branch first (draw the body's own rotation
				// if it has any), then a velocity branch, then the deadband. The physical branch was there so a
				// genuinely rolling ball would be drawn from its rotation rather than its translation, and it
				// stayed first on the reasoning that it could only ever improve the picture. It cannot, here.
				// The bodies do accumulate real spin - `omegaPhysical` tracks `2 x |v|` - and that spin points
				// wherever the solver put it, which is not the direction this model calls forward. Selecting it
				// whenever it crossed a threshold made the markers **reverse mid-ride with no change in
				// `BALL_SPEED`**, which is the one thing the user asked never to see.
				//
				// `omegaPhysical` is still printed. It no longer decides anything.
				//
				// **The rate comes from `BALL_SPEED` and from nothing else.**
				//
				// The physical spin of these bodies is not a second opinion, it is a by-product of the solver
				// resolving contact on a floor this codebase moves them along: the log shows `omegaPhysical`
				// tracking `2 x |v|` exactly (0.394 at `|v| = 0.203`, 7.296 at `|v| = 3.589`), i.e. the ball really
				// is rolling, in world space, in whichever direction the engine decided. Letting that compete with
				// the attribute is what made the markers **change direction mid-ride**: the two agreed for a while
				// and then the physical branch took over, reversing the picture with no change in `BALL_SPEED`.
				//
				// The user's requirement is that the ball never renders a backwards spin. The only way to guarantee
				// that is to have one source of truth for the rate and one for the axis, both derived from the
				// model. `omegaPhysical` is still printed as a diagnostic; it no longer decides anything.
				// **With a phantom, this controller applies no rate at all** ? the skin's own roll is the picture, and adding a
				// second rotation on top would double the drawn speed. `rateSource=phantom` in the log is how a run says which
				// path posed the markers.
				let omega: number;
				if (phantom !== undefined) {
					omega = 0;
					rateSource = "phantom";
					axisSource = "phantom";
					// **Reported, not applied (item 188).** `omega` stays `0` because the phantom's own roll is the picture, but
					// the log used to print `omegaVisual=0 angle=0` on this path for that reason alone — a reader could not tell
					// "the skin is not turning" from "this field only exists on the fallback branch". Printing the rate the
					// skin is using makes the log answer the question it looks like it answers.
					omegaThisFrame = apparentSpinRate(ballSpeed);
				} else if (ballSpeed > SPIN_DEADBAND_SPEED) {
					// One formula, in `shared/apparent-spin.ts`, so this path and the skin cannot disagree about the rate even
					// though only one of them is accumulating an angle.
					omega = apparentSpinRate(ballSpeed);
					rateSource = "attribute";
				} else {
					omega = 0;
					rateSource = "deadband";
				}

				// ## Axis: always the belt's, never the body's
				//
				// **Every source of variance is gone.** The physical-spin axis and the travel axis both changed
				// direction mid-ride - the first because the solver's rolling direction is not the model's, the
				// second because the world velocity reverses on a boost - and either one flipping made the markers
				// reverse while `BALL_SPEED` was still climbing. The axis is now a pure function of the belt, so the
				// ball turns the same way for its whole life: forward at spawn, slower as the attribute decays,
				// faster on a pickup, never backwards.
				// **Fallback only.** With a skin present the markers are posed inside its frame below, and this whole block is
				// skipped - running it would be a second rotation stacked on the one the phantom already carries.
				if (phantom === undefined) {
					let axis: Vector3 | undefined;

					if (axis === undefined) {
						// Neither spinning nor moving: a ball at rest on the belt. The rate is `0` here, so nothing
						// rotates — but the axis is still resolved because the log line reports which source it
						// came from, and because a ball that starts moving must turn about a defined axis on its
						// first moving frame rather than one frame later.
						axis = beltSpinAxis();
						axisSource = "belt";
					}

					// One sign for all three sources, so a ball crossing from sliding to rolling does not reverse.
					axis = axis.mul(APPARENT_SPIN_SIGN);

					// Pre-multiplied because the rotation is expressed in world space and must be applied about
					// the body's *current* centre, not accumulated in the body's own turning frame.
					//
					// `omega = 0` is exactly inert here, which is what makes the deadband a real hold rather than
					// a near-miss: `fromAxisAngle(axis, 0)` is the identity, so `spin` is multiplied by identity
					// and `angle += 0 * dt` adds nothing. The accumulated pose is preserved bit-for-bit, so a
					// parked ball's markers neither advance nor drift and a ball that resumes turns from exactly
					// the orientation it stopped at.
					state.spin = CFrame.fromAxisAngle(axis, omega * frameDt).mul(state.spin);
					state.angle += omega * frameDt;
					omegaThisFrame = omega;

					// Re-orthonormalise every five seconds at 60 Hz. **This guard exists because the model
					// changed:** the earliest model often computed a zero rate, so `spin` was frequently left
					// untouched and accumulated at most a few hundred multiplies per body. A moving ball now
					// rotates continuously, which is ~18,000 multiplies a minute and ~288,000 over a ten-minute
					// session. A product of thousands of float matrices drifts off orthonormal, and a drifted
					// basis is not a cosmetic problem here: the marker pose is `spunBody * localFrame`, so scale
					// error in the basis moves the markers off the sphere's surface, which would read as a new
					// and mysterious bug rather than as accumulated float error.
					//
					// `fromMatrix` with two unit columns produces an exactly orthonormal third (`vX:Cross(vY)`),
					// so this costs two normalisations and one allocation per body per five seconds.
					state.framesSinceNormalize++;
					if (state.framesSinceNormalize >= NORMALIZE_SPIN_EVERY_FRAMES) {
						state.framesSinceNormalize = 0;
						state.spin = CFrame.fromMatrix(
							Vector3.zero,
							state.spin.RightVector.Unit,
							state.spin.UpVector.Unit,
						);
					}
				}

				// A marker whose parent is no longer this body has left it — reparented, or the body is being
				// torn down. Pruned only when it actually happens, rather than rebuilding the list every
				// frame: at 50 bodies that would be 3000 short arrays a second to detect a change that
				// occurs three times per body per lifetime.
				if (state.markers.some((entry) => entry.marker.Parent !== body)) {
					const kept = state.markers.filter((entry) => entry.marker.Parent === body);
					if (kept.size() === 0) {
						bodies.delete(body);
						continue;
					}

					state.markers = kept;
				}

				// The spin is a world-space rotation about the body's centre, so it is applied between two
				// translations: to origin, rotate, back. Composed once per body rather than once per marker,
				// then the three local frames are applied on top, which is also what keeps the poles on the
				// spin axis' antipodes and the ring in its perpendicular plane — they are moving together
				// because they share one rotation, not because their geometry is special-cased.
				const pivot = new CFrame(position);
				// **The skin's frame is the marker's frame.** When a phantom exists it is already at the ball's position carrying the
				// one roll this round draws, so posing the markers in it is what makes the six face textures and the three markers
				// turn together. The `body.CFrame` path is the fallback: it rotates the marker set by this controller's own angle
				// about the ball's centre, which is exactly what item 44 shipped ? degraded (it inherits the body's physical
				// orientation) but moving, and it is the path a client takes if the skin controller never ran.
				const spunBody =
					phantom !== undefined
						? phantom.CFrame
						: pivot.mul(state.spin).mul(pivot.Inverse()).mul(body.CFrame);

				for (const entry of state.markers) {
					entry.marker.CFrame = spunBody.mul(entry.localFrame);
				}

				// TEMPORARY INSTRUMENTATION. One line per second for the body chosen above, ending in the
				// read-back that settles the only question this log cannot answer by eye: whether a client's
				// `CFrame` write to a server-owned anchored part actually sticks. `writeError` is
				// `|intended - actual|` on the first marker *after* the write; if it is stable and small the
				// write landed, and a marker that still looks still is a rendering question rather than a
				// scripting one. If it is large and roughly the ball's distance from its spawn point, the write
				// is being reverted and this whole approach has to move to the server.
				if (state === sample) {
					const first = state.markers[0];
					const firstMarker = first === undefined ? undefined : first.marker;
					const intended = first === undefined ? undefined : spunBody.mul(first.localFrame).Position;
					const writeError =
						firstMarker === undefined || intended === undefined
							? -1
							: intended.sub(firstMarker.Position).Magnitude;

					// The conclusion, not just the measurement. A write that does not stick is the one failure
					// this design cannot survive, and it is invisible in every other diagnostic: the angle
					// accumulates correctly, the maths is right, and the marker simply does not move. Saying so
					// explicitly stops the next run being read as "the controller is broken" when the actual
					// finding is "a client cannot pose a server-owned anchored part".
					if (writeError > 0.05 && !state.writeWarned) {
						state.writeWarned = true;
						warn(
							`[MarkerSpin] CFrame write did NOT stick: intended=${intended === undefined ? "?" : describeVector(intended)} actual=${firstMarker === undefined ? "?" : describeVector(firstMarker.Position)} error=${describeNumber(writeError)}. The client cannot pose this marker, so the spin has to be driven from the server.`,
						);
					}

					// `|v|` is the body's own replicated property, printed next to the smoothed `speed` the
					// controller actually uses, so a disagreement between them is visible rather than inferred.
					// `omegaVisual` is the per-ball rate as computed this frame — the number the tuning prompt
					// after this one needs as a baseline, and the one that must read 0 while the ball is parked.
					const frameLabel = traceThisFrame ? `boot f=${BOOT_TRACE_FRAMES - bootFramesRemaining}` : "state";

					print(
						`[MarkerSpin] ${frameLabel} bodies=${bodies.size()} tracked=${trackedMarkers.size()} markers=${state.markers.size()} body="${body.GetFullName()}" |v|=${describeNumber(replicatedVelocity.Magnitude)} velocitySource=${source} BALL_SPEED=${describeNumber(ballSpeed)} rateSource=${rateSource} omegaPhysical=${describeNumber(body.AssemblyAngularVelocity.Magnitude)} axis=${axisSource} omegaVisual=${describeNumber(omegaThisFrame)} r=${describeNumber(state.radius)} angle=${describeNumber(state.angle)} bodyPos=${describeVector(position)} markerPos=${firstMarker === undefined ? "none" : describeVector(firstMarker.Position)} writeError=${describeNumber(writeError)}`,
					);
				}
			}
		});
	}
}

/**
 * The forward-rolling axis implied by the belt, for a body that is neither spinning nor moving.
 *
 * `yAxis:Cross(belt.RightVector)` — for the observed belt (`RightVector = +X`) that is `-Z`, the axis
 * that moves the top of the ball toward `+X`. It is the negation of the belt's *braking* axis
 * (`belt.CFrame.RightVector:Cross(Vector3.yAxis)`), and the two differ by sign and
 * mean opposite things, so a reader who reuses one for the other gets markers turning backwards.
 *
 * The belt is found by tag (the only coupling between scene and code, per `shared/tags.ts`) and
 * cached: this is asked once per body per frame, and a `GetTagged` walk per body per frame at the
 * 50-body cap would be 3000 enumerations a second to answer a question whose answer only changes when
 * the tag does. The cache is invalidated by the belt's own `Parent` going nil, which is what a Studio
 * re-tag or a scene reload looks like from here.
 *
 * The `(0, 0, -1)` last resort is not a guess: it is the same axis the observed belt produces, so a
 * client that has not yet received the belt still draws markers turning the direction they will turn
 * once it arrives. Without a hard fallback the alternative would be no axis, and a null axis on the
 * offset path is exactly the "no spin at all" symptom this round exists to remove.
 */
let cachedBelt: BasePart | undefined;

function beltSpinAxis(): Vector3 {
	if (cachedBelt === undefined || cachedBelt.Parent === undefined) {
		cachedBelt = undefined;

		for (const instance of CollectionService.GetTagged(TAGS.treadmillBelt)) {
			if (instance.IsA("BasePart") && instance.Parent !== undefined) {
				cachedBelt = instance;
				break;
			}
		}
	}

	if (cachedBelt !== undefined) {
		const axisRaw = Vector3.yAxis.Cross(cachedBelt.CFrame.RightVector);
		if (axisRaw.Magnitude >= 1e-3) {
			return axisRaw.Unit;
		}
	}

	return new Vector3(0, 0, -1);
}

/**
 * Reads the marker's spawn pose relative to its body, from the attributes the server wrote.
 *
 * Returns `undefined` if any of the three is missing or the wrong type, so the caller can warn once
 * instead of building a `CFrame` out of garbage. `fromMatrix` derives the third basis vector from the
 * first two (`vX:Cross(vY).Unit` per the typings), which is why two vectors are enough to carry a
 * rotation exactly — the equatorial ring's 90° tilt survives because its basis is sent, not an Euler
 * triple that would have to be re-assembled in the right order.
 *
 * The degenerate case is caught because `Cross` of parallel vectors is zero, and `fromMatrix` on a zero
 * column produces an unusable rotation rather than an error.
 */
function readLocalFrame(marker: BasePart): CFrame | undefined {
	const position = marker.GetAttribute(MARKER_LOCAL_POSITION_ATTRIBUTE);
	const right = marker.GetAttribute(MARKER_LOCAL_RIGHT_ATTRIBUTE);
	const up = marker.GetAttribute(MARKER_LOCAL_UP_ATTRIBUTE);

	if (!typeIs(position, "Vector3") || !typeIs(right, "Vector3") || !typeIs(up, "Vector3")) {
		return undefined;
	}

	if (right.Magnitude < 1e-3 || up.Magnitude < 1e-3 || right.Cross(up).Magnitude < 1e-3) {
		return undefined;
	}

	return CFrame.fromMatrix(position, right, up);
}
