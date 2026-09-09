/**
 * Pose definitions.
 *
 * `angles` gives each scored joint [ target°, tolerance° ]. `weights` says how
 * much of the pose that joint actually is — an unweighted mean lets a straight
 * elbow count for as much as a collapsed standing leg. Weights are relative
 * within a pose; only their ratios matter.
 *
 * Extracted from index.html so tests can import them. The schema is documented
 * where the fields are first used; Phase 4 of the improvement brief turns this
 * into a validated, declarative format.
 */

// ─────────────────────────────────────────────────────────────
// Yoga Pose Data (templates + guide content)
// ─────────────────────────────────────────────────────────────
// `rig` drives the animated demo figure: each entry is the direction of a body
// segment, either `theta` (degrees, 0° = right, 90° = up on screen) or
// `[theta, phi]` where phi tilts the segment out of the frontal plane, away from
// the camera. All five of these poses are planar, so every phi here is 0 — which
// is exactly why their anatomical 3D angles equal the angles of a flat rig.
//
// `angles` are true 3D joint angles, measured from MediaPipe's world landmarks,
// so they no longer depend on where the camera stands. Each target is derived
// from the rig above it, keeping the demo figure, the target outline and the
// scoring as descriptions of one single shape.
export const YOGA_POSES = {
  mountain: {
    name: "Mountain Pose",
    sanskrit: "Tadasana",
    emoji: "🏔️",
    description: "The foundation of all standing poses — builds awareness of posture and balance.",
    steps: [
      { text: "Stand with your feet together, big toes touching", focus: ["left_leg","right_leg"] },
      { text: "Distribute your weight evenly across both feet", focus: ["left_leg","right_leg"] },
      { text: "Let your arms hang naturally at your sides, palms facing forward", focus: ["left_arm","right_arm"] },
      { text: "Lengthen your spine upward through the crown of your head", focus: ["torso","head"] },
      { text: "Relax your shoulders down and back, away from your ears", focus: ["torso"] },
    ],
    tips: [
      { icon: "✅", text: "Keep your knees straight but not locked" },
      { icon: "✅", text: "Engage your core gently" },
      { icon: "⚠️", text: "Don't lean forward or backward" },
    ],
    rig: {
      torso: 90,
      arm_left: [-75, -65], arm_right: [-105, -115],
      leg_left: [-85, -90], leg_right: [-95, -90],
    },
    angles: {
      left_knee:[175,20], right_knee:[175,20],
      left_hip:[173,20], right_hip:[173,20],
      left_shoulder:[17,20], right_shoulder:[17,20],
      left_elbow:[170,20], right_elbow:[170,20],
    },
    // Mountain is a posture, not a shape: the legs and the line of the spine
    // are the pose, and the arms are just hanging there.
    weights: {
      left_knee: 2,
      right_knee: 2,
      left_hip: 2,
      right_hip: 2,
      left_shoulder: 1,
      right_shoulder: 1,
      left_elbow: 1,
      right_elbow: 1,
    },
  },
  warrior1: {
    name: "Warrior I",
    sanskrit: "Virabhadrasana I",
    emoji: "⚔️",
    description: "A powerful standing pose that strengthens legs and opens the chest.",
    steps: [
      { text: "From Mountain Pose, step your right foot back about 3–4 feet", focus: ["right_leg"] },
      { text: "Bend your left (front) knee to about 90°, stacked over the ankle", focus: ["left_leg"] },
      { text: "Keep your back leg straight and strong, heel pressing down", focus: ["right_leg"] },
      { text: "Raise both arms overhead, reaching toward the ceiling", focus: ["left_arm","right_arm"] },
      { text: "Square your hips toward the front of your mat", focus: ["torso"] },
    ],
    tips: [
      { icon: "✅", text: "Front knee should be directly over the ankle" },
      { icon: "✅", text: "Keep both arms straight and parallel" },
      { icon: "⚠️", text: "Don't let your front knee extend past your toes" },
    ],
    rig: {
      torso: 90,
      arm_left: [80, 85], arm_right: [100, 95],
      leg_left: [-20, -105], leg_right: [-110, -105],
    },
    angles: {
      left_knee:[95,22], right_knee:[175,20],
      left_hip:[108,25], right_hip:[158,25],
      left_shoulder:[172,25], right_shoulder:[172,25],
      left_elbow:[175,22], right_elbow:[175,22],
    },
    // Both legs carry the pose — the bent front knee and the straight back one.
    // Square hips are the thing everyone gets wrong. Elbows barely matter.
    weights: {
      left_knee: 3,
      right_knee: 3,
      left_hip: 2,
      right_hip: 2,
      left_shoulder: 2,
      right_shoulder: 2,
      left_elbow: 1,
      right_elbow: 1,
    },
  },
  warrior2: {
    name: "Warrior II",
    sanskrit: "Virabhadrasana II",
    emoji: "🗡️",
    description: "Builds stamina and focus while stretching the hips and shoulders.",
    steps: [
      { text: "Stand with your feet wide apart, about 4 feet", focus: ["left_leg","right_leg"] },
      { text: "Turn your left foot out 90° and your right foot slightly inward", focus: ["left_leg","right_leg"] },
      { text: "Bend your left knee to 90°, directly over the ankle", focus: ["left_leg"] },
      { text: "Extend both arms out horizontally at shoulder height", focus: ["left_arm","right_arm"] },
      { text: "Turn your head to gaze over your left fingertips", focus: ["head","left_arm"] },
    ],
    tips: [
      { icon: "✅", text: "Arms should form a straight line, parallel to the floor" },
      { icon: "✅", text: "Keep your torso upright, not leaning forward" },
      { icon: "⚠️", text: "Back leg must stay completely straight" },
    ],
    rig: {
      torso: 90,
      arm_left: [0, -5], arm_right: [180, 185],
      leg_left: [-10, -95], leg_right: [-130, -125],
    },
    angles: {
      left_knee:[95,22], right_knee:[175,20],
      left_hip:[98,25], right_hip:[138,25],
      left_shoulder:[92,25], right_shoulder:[92,25],
      left_elbow:[175,20], right_elbow:[175,20],
    },
    // As Warrior I, plus the arm line, which is half of what the pose looks
    // like and is held at shoulder height for a long time.
    weights: {
      left_knee: 3,
      right_knee: 3,
      left_hip: 2,
      right_hip: 2,
      left_shoulder: 2,
      right_shoulder: 2,
      left_elbow: 1,
      right_elbow: 1,
    },
  },
  tree: {
    name: "Tree Pose",
    sanskrit: "Vrksasana",
    emoji: "🌳",
    description: "A balancing pose that improves focus and strengthens the standing leg.",
    steps: [
      { text: "Stand tall on your left leg, grounding through the foot", focus: ["left_leg"] },
      { text: "Place your right foot on your inner left thigh (or calf — never the knee)", focus: ["right_leg"] },
      { text: "Press your foot and thigh into each other, opening the right knee out", focus: ["right_leg"] },
      { text: "Raise both arms straight overhead, palms facing each other", focus: ["left_arm","right_arm"] },
      { text: "Fix your gaze on a steady point ahead for balance", focus: ["head"] },
    ],
    tips: [
      { icon: "✅", text: "Standing leg should be completely straight" },
      { icon: "✅", text: "Open the bent knee out to the side" },
      { icon: "⚠️", text: "Never rest your foot on the knee joint" },
    ],
    rig: {
      torso: 90,
      arm_left: [80, 85], arm_right: [100, 95],
      leg_left: [-85, -90], leg_right: [-140, -15],
    },
    angles: {
      left_knee:[175,20], right_knee:[55,30],
      left_hip:[173,20], right_hip:[128,30],
      left_shoulder:[172,25], right_shoulder:[172,25],
      left_elbow:[175,20], right_elbow:[175,20],
    },
    // The standing leg and level hips are the whole balance. The raised knee
    // opening out matters next. The arms overhead are the least of it.
    weights: {
      left_knee: 3,
      right_knee: 2,
      left_hip: 3,
      right_hip: 3,
      left_shoulder: 1,
      right_shoulder: 1,
      left_elbow: 1,
      right_elbow: 1,
    },
  },
  triangle: {
    name: "Triangle Pose",
    sanskrit: "Trikonasana",
    emoji: "🔺",
    description: "A deep stretch for the hamstrings, hips, and spine.",
    steps: [
      { text: "Stand with your feet wide apart, about 4 feet", focus: ["left_leg","right_leg"] },
      { text: "Turn your left foot out 90° and your right foot slightly inward", focus: ["left_leg","right_leg"] },
      { text: "Extend both arms out to the sides at shoulder height", focus: ["left_arm","right_arm"] },
      { text: "Hinge sideways at the hips and reach your left hand down to your shin", focus: ["torso","left_arm"] },
      { text: "Extend your right arm straight up, stacked over the left", focus: ["right_arm"] },
    ],
    tips: [
      { icon: "✅", text: "Both legs stay completely straight" },
      { icon: "✅", text: "Keep your torso in one plane — don't lean forward" },
      { icon: "⚠️", text: "Don't collapse your chest — keep it open" },
    ],
    rig: {
      torso: 35,
      arm_left: [-55, -50], arm_right: [125, 130],
      leg_left: [-60, -55], leg_right: [-120, -115],
    },
    angles: {
      left_knee:[175,20], right_knee:[175,20],
      left_hip:[93,25], right_hip:[157,25],
      left_shoulder:[92,25], right_shoulder:[92,25],
      left_elbow:[175,20], right_elbow:[175,20],
    },
    // Both legs straight is the instruction people break, and the hinge is at
    // the hip rather than the waist. The arm line follows from those.
    weights: {
      left_knee: 3,
      right_knee: 3,
      left_hip: 3,
      right_hip: 2,
      left_shoulder: 2,
      right_shoulder: 2,
      left_elbow: 1,
      right_elbow: 1,
    },
  },
};

// [ too small an angle, too large an angle ] — a joint angle grows as the joint
// straightens, so the first string always fixes an over-bent joint.
export const CORRECTION_TIPS = {
  left_knee:     ["Straighten your left knee", "Bend your left knee more"],
  right_knee:    ["Straighten your right knee", "Bend your right knee more"],
  left_hip:      ["Open your left hip more", "Close your left hip"],
  right_hip:     ["Open your right hip more", "Close your right hip"],
  left_shoulder: ["Raise your left arm", "Lower your left arm"],
  right_shoulder:["Raise your right arm", "Lower your right arm"],
  left_elbow:    ["Straighten your left arm", "Bend your left elbow"],
  right_elbow:   ["Straighten your right arm", "Bend your right elbow"],
};
