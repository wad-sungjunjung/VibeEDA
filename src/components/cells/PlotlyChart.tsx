import { forwardRef } from 'react'
import createPlotlyComponent from 'react-plotly.js/factory'
import Plotly from 'plotly.js-cartesian-dist-min'

const Plot = createPlotlyComponent(Plotly as unknown as Parameters<typeof createPlotlyComponent>[0])

interface PlotlyChartProps {
  data: Plotly.Data[]
  layout: Partial<Plotly.Layout>
  width: number
  height: number
}

const PlotlyChart = forwardRef<HTMLDivElement, PlotlyChartProps>(function PlotlyChart(
  { data, layout, width, height },
  ref,
) {
  return (
    <div ref={ref} style={{ width, height, maxWidth: '100%' }}>
      <Plot
        data={data}
        layout={layout}
        config={{ responsive: true, displayModeBar: false }}
        style={{ width: '100%', height: '100%' }}
        useResizeHandler
      />
    </div>
  )
})

export default PlotlyChart

export async function plotToPngDataUrl(gd: HTMLElement): Promise<string> {
  return await (Plotly as unknown as { toImage: (gd: HTMLElement, opts: { format: string; scale: number }) => Promise<string> })
    .toImage(gd, { format: 'png', scale: 2 })
}
