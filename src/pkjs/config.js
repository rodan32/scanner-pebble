module.exports = [
  { type: 'heading', defaultValue: 'Scanner Feed' },
  { type: 'text', defaultValue: 'Connection to your scanner backend (behind NPM basic auth).' },
  {
    type: 'section',
    items: [
      {
        type: 'input',
        messageKey: 'HOST',
        label: 'Host',
        defaultValue: 'transcripts.zarchstuff.com',
        attributes: { placeholder: 'transcripts.zarchstuff.com' }
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
          { label: 'All', value: '2' }
        ]
      }
    ]
  },
  { type: 'submit', defaultValue: 'Save' }
];
