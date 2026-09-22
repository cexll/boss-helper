import { defineUnlistedScript } from '#imports'

// WXT evaluates entry metadata in Node; browser resources start only at runtime.
export default defineUnlistedScript(async () => {
  const script = document.currentScript as HTMLScriptElement
  const { main } = await import('./runtime')
  await main(script)
})
