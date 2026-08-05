import { defineBuildConfig } from 'obuild/config'

export default defineBuildConfig({
  entries: [
    {
      type: 'bundle',
      input: ['./src/index.ts', './src/cli.ts'],
      outDir: './dist',
      dts: true,
      rolldown: {
        external: [
          '@unocss/preset-wind4',
          'cmdore',
          'liquidjs',
          'unocss/vite',
          'vite',
        ],
      },
    },
  ],
})
