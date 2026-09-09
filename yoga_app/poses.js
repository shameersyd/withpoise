/**
 * Pose definitions.
 *
 * `angles` gives each scored joint [ target°, tolerance° ]. `weights` says how
 * much of the pose that joint actually is — an unweighted mean lets a straight
 * elbow count for as much as a collapsed standing leg. Weights are relative
 * within a pose; only their ratios matter.
 *
 * `symmetric: true` means the pose is the same on both sides. Everything else
 * carries `side`, and its mirror is generated rather than written out twice.
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
    symmetric: true,
    sanskrit: "Tadasana",
    emoji: "🏔️",
    view: "front",
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
      arm_left: { upper: -75, fore: -65 }, arm_right: { upper: -105, fore: -115 },
      leg_left: { thigh: -85, shin: -90 }, leg_right: { thigh: -95, shin: -90 },
    },
    // Mountain is a posture, not a shape: the legs and the line of the spine
    // are the pose, and the arms are just hanging there.
    joints: {
      default: { tolerance: 20, weight: 1 },
      left_knee: { weight: 2 }, right_knee: { weight: 2 },
      left_hip: { weight: 2 }, right_hip: { weight: 2 },
    },
  },
  warrior1: {
    name: "Warrior I",
    // Written for one side; the other is derived by mirrorPose(). For the
    // Warriors and Triangle this is the front/lower limb, for Tree the
    // standing leg — it is a label for which mirror this is, not anatomy.
    side: "left",
    sanskrit: "Virabhadrasana I",
    emoji: "⚔️",
    view: "front",
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
      arm_left: { upper: 80, fore: 85 }, arm_right: { upper: 100, fore: 95 },
      leg_left: { thigh: -20, shin: -105 }, leg_right: { thigh: -110, shin: -105 },
    },
    // Both legs carry the pose — the bent front knee and the straight back one.
    // Square hips are the thing everyone gets wrong. Elbows barely matter.
    joints: {
      default: { tolerance: 25, weight: 2 },
      left_knee: { tolerance: 22, weight: 3 },
      right_knee: { tolerance: 20, weight: 3 },
      left_elbow: { tolerance: 22, weight: 1 },
      right_elbow: { tolerance: 22, weight: 1 },
    },
  },
  warrior2: {
    name: "Warrior II",
    // Written for one side; the other is derived by mirrorPose(). For the
    // Warriors and Triangle this is the front/lower limb, for Tree the
    // standing leg — it is a label for which mirror this is, not anatomy.
    side: "left",
    sanskrit: "Virabhadrasana II",
    emoji: "🗡️",
    view: "front",
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
      arm_left: { upper: 0, fore: -5 }, arm_right: { upper: 180, fore: 185 },
      leg_left: { thigh: -10, shin: -95 }, leg_right: { thigh: -130, shin: -125 },
    },
    // As Warrior I, plus the arm line, which is half of what the pose looks
    // like and is held at shoulder height for a long time.
    joints: {
      default: { tolerance: 25, weight: 2 },
      left_knee: { tolerance: 22, weight: 3 },
      right_knee: { tolerance: 20, weight: 3 },
      left_elbow: { tolerance: 20, weight: 1 },
      right_elbow: { tolerance: 20, weight: 1 },
    },
  },
  tree: {
    name: "Tree Pose",
    // Written for one side; the other is derived by mirrorPose(). For the
    // Warriors and Triangle this is the front/lower limb, for Tree the
    // standing leg — it is a label for which mirror this is, not anatomy.
    side: "left",
    sanskrit: "Vrksasana",
    emoji: "🌳",
    view: "front",
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
      arm_left: { upper: 80, fore: 85 }, arm_right: { upper: 100, fore: 95 },
      leg_left: { thigh: -85, shin: -90 }, leg_right: { thigh: -140, shin: -15 },
    },
    // The standing leg and level hips are the whole balance. The raised knee
    // opening out matters next. The arms overhead are the least of it.
    joints: {
      default: { tolerance: 25, weight: 1 },
      left_knee: { tolerance: 20, weight: 3 },
      right_knee: { tolerance: 30, weight: 2 },
      left_hip: { tolerance: 20, weight: 3 },
      right_hip: { tolerance: 30, weight: 3 },
      left_elbow: { tolerance: 20 }, right_elbow: { tolerance: 20 },
    },
  },
  downdog: {
    name: "Downward Dog",
    sanskrit: "Adho Mukha Svanasana",
    emoji: "🐕",
    // The whole shape lives in the sagittal plane: hands and feet on the floor,
    // hips at the apex. Seen head-on it is a body pointing at the lens and
    // there is nothing in the image to measure, so it asks to be filmed from
    // the side — where every angle it cares about is laid out flat.
    view: "side",
    symmetric: true,
    description: "An inverted V that lengthens the whole back of the body — the pose you rest in.",
    steps: [
      { text: "Start on hands and knees, hands a little ahead of your shoulders", focus: ["left_arm","right_arm"] },
      { text: "Tuck your toes and lift your hips up and back", focus: ["torso"] },
      { text: "Straighten your legs as far as they go without rounding your back", focus: ["left_leg","right_leg"] },
      { text: "Press the floor away — arms straight, in one line with your spine", focus: ["left_arm","right_arm","torso"] },
      { text: "Let your head hang between your arms and look towards your feet", focus: ["head"] },
    ],
    tips: [
      { icon: "📐", text: "Stand side-on to the camera — this one can't be seen from the front" },
      { icon: "✅", text: "A long spine matters more than straight legs — bend the knees if you need to" },
      { icon: "⚠️", text: "Don't let your shoulders creep up around your ears" },
    ],
    rig: {
      torso: 221,
      arm_left: { upper: 218, fore: 213 }, arm_right: { upper: 218, fore: 213 },
      // 307 and 302 rather than round numbers: the torso-plus-arm line is
      // longer than the leg, so the two only reach the same floor if the legs
      // are laid a little shallower. Hands and feet ending at different heights
      // is the thing that makes a drawn Down Dog look wrong.
      leg_left: { thigh: 307, shin: 302 }, leg_right: { thigh: 307, shin: 302 },
    },
    // The hips are the pose; the legs are negotiable and the tips say so. The
    // arm line is what keeps the weight off the shoulders.
    joints: {
      default: { tolerance: 25, weight: 1 },
      left_hip: { tolerance: 22, weight: 3 }, right_hip: { tolerance: 22, weight: 3 },
      left_shoulder: { tolerance: 25, weight: 2 }, right_shoulder: { tolerance: 25, weight: 2 },
      left_knee: { tolerance: 30, weight: 1 }, right_knee: { tolerance: 30, weight: 1 },
      left_elbow: { tolerance: 20, weight: 2 }, right_elbow: { tolerance: 20, weight: 2 },
    },
  },
  triangle: {
    name: "Triangle Pose",
    // Written for one side; the other is derived by mirrorPose(). For the
    // Warriors and Triangle this is the front/lower limb, for Tree the
    // standing leg — it is a label for which mirror this is, not anatomy.
    side: "left",
    sanskrit: "Trikonasana",
    emoji: "🔺",
    view: "front",
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
      arm_left: { upper: -55, fore: -50 }, arm_right: { upper: 125, fore: 130 },
      leg_left: { thigh: -60, shin: -55 }, leg_right: { thigh: -120, shin: -115 },
    },
    // Both legs straight is the instruction people break, and the hinge is at
    // the hip rather than the waist. The arm line follows from those.
    joints: {
      default: { tolerance: 25, weight: 2 },
      left_knee: { tolerance: 20, weight: 3 },
      right_knee: { tolerance: 20, weight: 3 },
      left_hip: { weight: 3 },
      left_elbow: { tolerance: 20, weight: 1 },
      right_elbow: { tolerance: 20, weight: 1 },
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
