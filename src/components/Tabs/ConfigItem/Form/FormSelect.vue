<script lang="ts" setup>
import { keywordIncludeModeOptions, mergeCandidate } from '@/composables/useApplying/keywordRules'
import type { KeywordIncludeMode } from '@/types/formData'

const value = defineModel<string[]>('value', { required: true })

/** 任一/全部切换（FR-001 / t4）：绑定 groups.includeMode；旧单列表不绑定则不渲染。 */
const mode = defineModel<KeywordIncludeMode | undefined>('mode')

const props = defineProps<{
  /** 候选词（FR-005）：只来自用户用过的关键词；显式选中后并入词表。不提供即旧单列表行为。 */
  candidates?: string[]
  disabled?: boolean
}>()

const delimiter = /,|\s|\||，/

/** 候选多选的瞬态选中：与词表解耦；显式选中即在 addCandidates 并入词表并清空（FR-005）。 */
const picked = ref<string[]>([])

/** 显式选中的候选词只并入词表：不启用字段（enable），也不改任一/全部（includeMode）。 */
function addCandidates(next: string[]) {
  picked.value = []
  value.value = mergeCandidate(value.value, next)
}
</script>

<template>
  <div class="flex flex-col gap-1 w-full">
    <div v-if="mode != null" class="flex flex-row gap-1 items-center">
      <span class="text-xs text-gray-400">包含方式</span>
      <USelectMenu
        v-model="mode"
        :items="keywordIncludeModeOptions"
        value-key="value"
        label-key="label"
        size="xs"
        class="w-27.5"
        aria-label="包含方式"
      />
    </div>
    <UInputTags
      v-model="value"
      placeholder=""
      :delimiter="delimiter"
      addOnTab
      addOnBlur
      :duplicate="false"
      :disabled="disabled"
    />
    <div v-if="candidates?.length" class="flex flex-row gap-1 items-center">
      <span class="text-xs text-gray-400">候选词</span>
      <USelectMenu
        :model-value="picked"
        :items="candidates"
        multiple
        size="xs"
        class="w-full"
        aria-label="候选词"
        @update:model-value="addCandidates"
      />
    </div>
  </div>
</template>
