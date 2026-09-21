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
          { label: 'Home', value: '0' },
          { label: 'Local', value: '1' },
          { label: 'Utah Co', value: '2' },
          { label: 'All', value: '3' },
          { label: 'Faves', value: '4' }
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
      { type: 'text', defaultValue: 'Home areas: the strict home-area list behind the default "Home" preset — keep it narrow (default: Orem). Favorite areas: comma-separated agency/area names for the "Faves" preset (same names as the built-in presets, e.g. Orem, Provo, UHP). Mute talkgroups: comma-separated text — any call whose talkgroup contains one of these is hidden. All three fields show blank on open; leaving one blank keeps the current value, and typing "none" clears it (Home falls back to Orem).' }
    ]
  },
  { type: 'submit', defaultValue: 'Save' }
];
