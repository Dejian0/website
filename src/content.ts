// Single source of copy for every prototype. Do not add facts that are not here.
// Draft wording. Facts only; no grades, no client details.

export const person = {
  name: 'Dejian Zhou',
  line: 'Robotics and reinforcement learning. Mechanical engineering at MIT and ETH Zurich.',
  now: 'Now: soft robot arms at MIT CSAIL.',
}

export const bio = [
  "I study mechanical engineering at ETH Zurich and am spending the fall of 2026 at MIT as an exchange student. I work on how robots learn to move and to touch.",
  "At MIT CSAIL's Distributed Robotics Lab I am building a sensorized digital twin of a tendon-driven soft arm, and training policies that grasp unknown objects and reach through clutter using contact along the whole arm. Earlier in 2026 I worked on legged locomotion at ETH's Robotic Systems Lab, training ANYmal-D, a four-legged robot, to traverse complex obstacles in massively parallel simulation.",
  "I co-founded PVelion, which built a self-cleaning solar panel that sheds dust through vibration. I also used to teach piano in Dresden.",
]

export type Entry = {
  title: string
  role: string
  org: string
  dates: string
  blurb: string
  href?: string
}

export const work: Entry[] = [
  {
    title: 'Soft arm, digital twin',
    role: 'Undergraduate Researcher',
    org: 'MIT CSAIL, Distributed Robotics Lab (Prof. Daniela Rus)',
    dates: '2026 – now',
    blurb:
      'A sensorized digital twin of a tendon-driven soft robot arm in SoRoMoX, a differentiable, GPU-parallel Cosserat-rod simulator, validated against material tests and trajectories of the real arm. Deep reinforcement learning policies use pneumatic tactile signals to grasp unknown objects and reach through clutter with whole-arm contact.',
  },
  {
    title: 'Legged locomotion',
    role: 'Undergraduate Researcher',
    org: 'ETH Zurich, Robotic Systems Lab (Prof. Marco Hutter)',
    dates: '2026',
    blurb:
      'Extended a massively parallel training system that teaches ANYmal-D to traverse complex obstacles. Ported locomotion tasks to NVIDIA Isaac Lab and adapted a teacher-student pipeline that distills eight specialist policies into a single recurrent depth-camera policy.',
  },
  {
    title: 'Self-cleaning solar panel',
    role: 'Co-Founder',
    org: 'PVelion',
    dates: '2024 – 2025',
    blurb:
      'A solar panel that removes dust through vibration; the first prototype reached 95% cleanliness. Won the Startup Campus pitch competition and Innosuisse funding.',
  },
]

// A row's coursework, where it has one, goes on a line of its own under the row.
export const education: { school: string; detail: string; dates: string; courses?: string }[] = [
  { school: 'Massachusetts Institute of Technology', detail: 'Exchange student', dates: 'Fall 2026', courses: 'Coursework: Deep Learning, Feedback Control Systems, AI & Money' },
  { school: 'ETH Zurich', detail: 'BSc Mechanical Engineering', dates: '2024 – 2027' },
]

// Painted as Education's rows are: who gave it, what it is, and when (where known).
export const honors: { org: string; detail: string; dates?: string }[] = [
  { org: 'Swiss Study Foundation', detail: 'Merit scholarship' },
  { org: 'German Physical Society (DPG)', detail: 'Abitur Prize for physics', dates: '2024' },
]

// Painted as Honors' rows are: where, what I did there, and when.
export const volunteering: { org: string; detail: string; dates: string }[] = [
  { org: 'Young Founders Network', detail: 'Chapter lead, Switzerland', dates: '2025 – 2026' },
  { org: 'ETH Entrepreneur Club', detail: 'Logistics team, InCube Challenge', dates: '2025' },
  { org: 'Verein für musische Bildung', detail: 'Piano teacher', dates: '2023 – 2024' },
  { org: 'High School Finance Club', detail: 'Founder and head', dates: '2023 – 2024' },
]

export const skills = [
  'Python, PyTorch, C++, TypeScript',
  'Reinforcement learning, Isaac Lab, RSL-RL',
  'Slurm, multi-GPU training',
  'LLM systems, FastAPI, PostgreSQL',
  'German and Chinese (native), English (fluent), French (basic)',
]

// In two parts on purpose: the page puts the address together (see src/page/email.ts).
export const email = { user: 'dezhou', domain: 'mit.edu' }

export const contact = "Email is the best way to reach me, and I'm happy to send my CV."

export const links = [
  { label: 'GitHub', href: 'https://github.com/Dejian0' },
  { label: 'LinkedIn', href: 'https://www.linkedin.com/in/dejian-zhou' },
]

export const site = {
  note: 'The robot is a small four-legged walker I built for this site. A planner picks its route over the words, and the lines above it part to let it through. Its trotting gait chooses where each foot lands, and inverse kinematics bends each leg to reach it. Click it, then click anywhere to send it there, or drag it to give it a push.',
  source: { label: 'Source on GitHub', href: 'https://github.com/Dejian0/website' },
}
