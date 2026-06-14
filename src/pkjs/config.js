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
        label: 'Default filter',
        defaultValue: '0',
        options: [
          { label: 'Local', value: '0' },
          { label: 'Utah Co', value: '1' },
          { label: 'All', value: '2' },
          { label: 'Faves', value: '3' }
        ]
      },
      {
        type: 'input',
        messageKey: 'FAVE_AREAS',
        label: 'Favorite areas',
        attributes: { placeholder: 'Orem, Provo, UHP' }
      },
      {
        type: 'input',
        messageKey: 'MUTE_TAGS',
        label: 'Mute talkgroups',
        attributes: { placeholder: 'Orem PD, Dispatch' }
      },
      { type: 'text', defaultValue: 'Favorite areas: comma-separated agency/area names for the "Faves" preset (same names as the built-in presets, e.g. Orem, Provo, UHP). Mute talkgroups: comma-separated text — any call whose talkgroup contains one of these is hidden. Both fields show blank on open; leaving one blank keeps the current value, and typing "none" clears it.' }
    ]
  },
  { type: 'submit', defaultValue: 'Save' }
];
