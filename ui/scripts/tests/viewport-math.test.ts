// Gesture signs, camera helpers and key-light angles (Z-up world).
import { assertViewportGestures, clampedZoom, cloneCamera, defaultCamera, DEFAULT_LIGHT } from "../../src/viewportCamera";
import { anglesToLight, lightToAngles } from "../../src/components/StudioViewport3D";
import { check, done } from "./check";

assertViewportGestures();
check(true, "viewport gesture signs match the Mac viewport");

// Default key light is ~43° above the bed, front-right.
const d = lightToAngles(DEFAULT_LIGHT);
check(d.elevation >= 40 && d.elevation <= 46, `default light elevation ${d.elevation}° is above the model`);
check(d.azimuth > 0 && d.azimuth < 90, `default light azimuth ${d.azimuth}° is front-right`);

// Elevation 89° is overhead (+Z), not level and behind.
const overhead = anglesToLight(0, 89);
check(overhead[2] > 0.99, "elevation 89° puts the light overhead");
const front = anglesToLight(0, 0);
check(front[1] < -0.99, "azimuth 0°, elevation 0° is the front (−Y)");
check(anglesToLight(90, 0)[0] > 0.99, "azimuth 90° is +X");

for (const az of [-170, -90, -30, 0, 45, 120, 179]) {
  for (const el of [-80, -20, 0, 30, 60, 85]) {
    const back = lightToAngles(anglesToLight(az, el));
    check(back.azimuth === az && back.elevation === el, `light angles round-trip (${az}°, ${el}°)`, true);
  }
}

check(clampedZoom(0.001) === 0.4 && clampedZoom(99) === 3.5 && clampedZoom(NaN) === 1, "zoom clamps, NaN falls back to 1");
const a = defaultCamera();
const b = cloneCamera(a);
b.direction[0] += 1; b.up[1] += 1; b.pan[2] += 1; b.light[0] += 1;
check(a.direction[0] !== b.direction[0] && a.up[1] !== b.up[1] && a.pan[2] !== b.pan[2] && a.light[0] !== b.light[0], "cloneCamera copies every vector");
done();
