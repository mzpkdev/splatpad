import { defineArgument } from 'cmdore'

export const siteRoot = defineArgument({
  name: 'root',
  description: 'Directory containing the Liquid site.',
})
