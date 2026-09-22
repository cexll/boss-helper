<script lang="tsx" setup>
import { DevLoggerUI } from 'devlog-ui'
const logsRef = useTemplateRef('logsRef')
onMounted(() => {
  if (logsRef.value) {
    DevLoggerUI.init({ body: logsRef.value })
  }
})
</script>

<template>
  <div ref="logsRef"></div>
</template>
