/**
 * Which way is down.
 *
 * The app assumes the camera is upright, and everything that says "vertical" —
 * the body frame's spine axis, a yaw, the ground — inherits that assumption. A
 * phone propped against a water bottle is not upright, and nothing until now
 * had any way to know.
 *
 * The phone does know. This reads it, and says so when it cannot.
 *
 * ── The derivation ─────────────────────────────────────────────────────────
 *
 * DeviceOrientationEvent gives intrinsic Z-X'-Y'' Euler angles taking the earth
 * frame to the device frame: R = Rz(α)·Rx(β)·Ry(γ). Gravity in the earth frame
 * is (0, 0, −1), since earth z is up. So in device coordinates:
 *
 *     g_device = Rᵀ·(0,0,−1) = −(third row of R)
 *
 * Rz contributes nothing to the third row, so only β and γ matter — which is
 * the useful part, because α (compass heading) is the one that drifts and the
 * one that needs a magnetometer:
 *
 *     row₃(Rx(β)·Ry(γ)) = (−cosβ·sinγ,  sinβ,  cosβ·cosγ)
 *     g_device          = ( cosβ·sinγ, −sinβ, −cosβ·cosγ)
 *
 * Device axes are x right, y up the screen, z out of the screen. The landmark
 * convention is x right, y DOWN, z away from the camera — so y and z both flip:
 *
 *     g_camera = (cosβ·sinγ, sinβ, cosβ·cosγ)
 *
 * Two checks. Upright portrait (β=90°, γ=0) gives (0, 1, 0): gravity straight
 * down the image, which is what upright means. Flat on a table facing the
 * ceiling (β=0, γ=0) gives (0, 0, 1): gravity directly away from the lens.
 */

/** The gravity direction in camera coordinates, as a unit vector. */
export function gravityFromOrientation(betaDegrees, gammaDegrees) {
  const b = (betaDegrees || 0) * Math.PI / 180;
  const g = (gammaDegrees || 0) * Math.PI / 180;
  return {
    x: Math.cos(b) * Math.sin(g),
    y: Math.sin(b),
    z: Math.cos(b) * Math.cos(g),
  };
}

/**
 * How far the camera is from upright, in degrees.
 *
 * Zero means gravity runs straight down the image and the app's assumption
 * holds exactly. 90° means the phone is lying flat.
 */
export function tiltFromUpright(gravity) {
  const length = Math.hypot(gravity.x, gravity.y, gravity.z) || 1;
  const down = Math.max(-1, Math.min(1, gravity.y / length));
  return Math.acos(down) * 180 / Math.PI;
}

/**
 * How far the image's "down" is rotated, in degrees. Portrait is 0, landscape
 * is ±90.
 *
 * This one is correctable in principle: the body is still fully in view and
 * fully in plane, the frame is simply turned. Rotating the body frame by −roll
 * would recover it.
 */
export function rollFromGravity(gravity) {
  return Math.atan2(gravity.x, gravity.y) * 180 / Math.PI;
}

/**
 * How far the camera is pitched up or down, in degrees. Positive means the lens
 * is tilted back and looking upward.
 *
 * This one is not correctable. A camera looking up at a body foreshortens it
 * vertically and projects the floor plane differently, and no rotation of the
 * result recovers what the projection lost. It is the reading worth acting on.
 */
export function pitchFromGravity(gravity) {
  const length = Math.hypot(gravity.x, gravity.y, gravity.z) || 1;
  return Math.asin(Math.max(-1, Math.min(1, gravity.z / length))) * 180 / Math.PI;
}

// Past this much pitch the vertical the app reasons with is meaningfully not
// the world's, and a pose measured against it is being measured against a
// slope. 12° is roughly a phone propped on a book rather than standing — the
// point at which the foreshortening starts to show in the hip and knee angles.
export const TILT_WARN_DEGREES = 12;

/**
 * Live camera tilt, where the device will say.
 *
 * Absent, denied, or a device with no sensors: `available` stays false and
 * every reading is the upright default, which is exactly what the app assumed
 * before this existed. Nothing downstream needs a branch.
 */
export class Tilt {
  constructor() {
    this.available = false;
    this.gravity = { x: 0, y: 1, z: 0 };   // upright until told otherwise
    this.tiltDegrees = 0;
    this.rollDegrees = 0;
    this.pitchDegrees = 0;
    this.movedSinceCalibration = false;
    this._calibratedAt = null;
    this._handler = null;
  }

  /** True when this device could tell us, whether or not it has yet. */
  static get supported() {
    return typeof DeviceOrientationEvent !== "undefined";
  }

  /**
   * Start listening. Must be called from a real user gesture on iOS, which
   * gates the sensors behind a permission prompt exactly as it gates audio —
   * so this rides the same tap that unlocks the voice.
   */
  async start() {
    if (!Tilt.supported || this._handler) return this.available;
    try {
      const request = DeviceOrientationEvent.requestPermission;
      if (typeof request === "function") {
        const verdict = await request.call(DeviceOrientationEvent);
        if (verdict !== "granted") return false;
      }
    } catch {
      return false;   // refused, or not in a gesture. Upright it is.
    }

    this._handler = (event) => {
      if (event.beta === null && event.gamma === null) return;
      this.available = true;
      this.gravity = gravityFromOrientation(event.beta, event.gamma);
      this.tiltDegrees = tiltFromUpright(this.gravity);
      this.rollDegrees = rollFromGravity(this.gravity);
      this.pitchDegrees = pitchFromGravity(this.gravity);
      // A phone that has been picked up and put down somewhere else invalidates
      // the bone lengths measured against the old view.
      if (this._calibratedAt !== null &&
          Math.abs(this.pitchDegrees - this._calibratedAt) > TILT_WARN_DEGREES) {
        this.movedSinceCalibration = true;
      }
    };
    try {
      addEventListener("deviceorientation", this._handler);
    } catch {
      this._handler = null;
      return false;
    }
    return true;
  }

  stop() {
    if (!this._handler) return;
    try { removeEventListener("deviceorientation", this._handler); } catch { /* ignore */ }
    this._handler = null;
  }

  /** Remember how the phone was standing when the user calibrated against it. */
  markCalibrated() {
    this._calibratedAt = this.pitchDegrees;
    this.movedSinceCalibration = false;
  }

  /** Is the camera pitched far enough to distort what it sees? */
  get tilted() { return Math.abs(this.pitchDegrees) > TILT_WARN_DEGREES; }
}
