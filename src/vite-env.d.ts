/// <reference types="vite/client" />

declare module 'plotly.js-cartesian-dist-min' {
  const plotly: typeof import('plotly.js')
  export default plotly
}

declare module 'react-plotly.js/factory' {
  import type { ComponentType } from 'react'
  import type { PlotParams } from 'react-plotly.js'
  const createPlotlyComponent: (plotly: unknown) => ComponentType<PlotParams>
  export default createPlotlyComponent
}
