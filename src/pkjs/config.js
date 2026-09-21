module.exports = [
  { type: 'heading', defaultValue: 'Scanner Feed' },
  { type: 'text', defaultValue: 'Connection to your scanner backend (behind NPM basic auth). Use the analytics host — data.zarchstuff.com — not the old transcripts host, which redirects and breaks auth.' },
  {
    type: 'section',
    items: [
      {
        type: 'input',
        messageKey: 'HOST',
        label: 'Host',
        defaultValue: 'data.zarchstuff.com',
        attributes: { placeholder: 'data.zarchstuff.com' }
      },
      {
        type: 'input',
        messageKey: 'USERNAME',
        label: 'Username',
        attributes: { placeholder: 'basic-auth user' }
      },
      {
        type: 'input',
        messageKey: 'PASSWORD',
        label: 'Password',
        attributes: { type: 'password', placeholder: 'basic-auth pass' }
      }
    ]
  },
  {
    type: 'section',
    items: [
      {
        type: 'select',
        messageKey: 'DEFAULT_FILTER',
        label: 'Opening view',
        defaultValue: '0',
        options: [
          { label: 'Home block', value: '0' },
          { label: 'Ward', value: '1' },
          { label: 'Neighborhood', value: '2' },
          { label: 'Nearby (~1 mi)', value: '3' },
          { label: 'Live calls', value: '4' }
        ]
      },
      {
        type: 'input',
        messageKey: 'HOME_AREAS',
        label: 'Home areas',
        attributes: { placeholder: 'Orem' }
      },
      {
        type: 'input',
        messageKey: 'MUTE_TAGS',
        label: 'Mute talkgroups',
        attributes: { placeholder: 'Orem PD, Dispatch' }
      },
      { type: 'text', defaultValue: 'The first four views are incident-level, widening outward from your home block; "Live calls" is the raw call feed. Long-press SELECT on the watch cycles them. Home areas: the agency/area list scoping the live call feed — keep it narrow (default: Orem). Mute talkgroups: comma-separated text; any call whose talkgroup contains one of these is hidden. Both fields show blank on open; leaving one blank keeps the current value, and typing "none" clears it (Home areas falls back to Orem).' }
    ]
  },
  { type: 'submit', defaultValue: 'Save' }
];
