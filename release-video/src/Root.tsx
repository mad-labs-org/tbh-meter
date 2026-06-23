import { Composition } from "remotion";
import { FPS } from "./kit";
import { Showcase, SHOWCASE_DURATION } from "./Showcase";
import { ShowcasePunchy, PUNCHY_DURATION } from "./Showcase2";
import { Release, RELEASE_DURATION } from "./Release";

export const Root = () => (
  <>
    {/* Per-release feature video (the default make-video.sh target): ONLY this release's surfaces. */}
    <Composition id="Release" component={Release} durationInFrames={RELEASE_DURATION} fps={FPS} width={1920} height={1080} />
    {/* Full product tour — a scene LIBRARY reused by Release; not a per-release deliverable on its own. */}
    <Composition id="ShowcasePunchy" component={ShowcasePunchy} durationInFrames={PUNCHY_DURATION} fps={FPS} width={1920} height={1080} />
    <Composition id="Showcase" component={Showcase} durationInFrames={SHOWCASE_DURATION} fps={FPS} width={1920} height={1080} />
  </>
);
