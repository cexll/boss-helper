<script lang="ts" setup>
import { computed, onMounted, ref } from 'vue'

import LLMModelManage from '@/components/AI/LLMModelManage.vue'
import LLMPromptEdit from '@/components/AI/LLMPromptEdit.vue'
import FormSwitch from '@/components/Tabs/ConfigItem/Form/FormSwitch.vue'
import { formInfoData, useConf } from '@/composables/conf'
import { useHelper } from '@/composables/useHelper'
import { counter } from '@/message'
import type { FormDataAi, JevConfig } from '@/types/formData'
import { canEnableJev } from '@/types/formData'
import { JEV_API_KEY_STORAGE_KEY, JEV_BASE_URL } from '@/utils/jev'

const helper = useHelper()
const conf = useConf()
const aiBoxShow = ref(false)
const aiConfBoxShow = ref(false)
const aiBox = ref<'aiGreeting' | 'aiFiltering' | 'aiReply' | 'record'>('aiGreeting')

function change(v: Partial<FormDataAi>) {
  v.enable = !v.enable
  conf.confSaving()
}

// ———— Jev 方向判断配置（FR-010 / AC-006）————
// jev 键由 defaultFormData 兜底，旧配置加载后同样是关闭状态（FR-006 口径）。
const jev = computed<JevConfig>(() => conf.formData.jev!)
const apiKey = ref('')
const apiKeyVisible = ref(false)
const jevConsentShow = ref(false)

const lockByWorkflow = computed(() => helper.workflow?.status.value === 'running')

/** 密钥或目标方向任一空白即不能启用（AC-006；与流水线共用同一判定）。 */
const jevCanEnable = computed(() =>
  canEnableJev({ apiKey: apiKey.value, targetDirection: jev.value.targetDirection }),
)
/** 启用后仍允许关闭：只有「未启用且缺项」时才禁用开关。 */
const jevSwitchDisabled = computed(
  () => lockByWorkflow.value || (!jevCanEnable.value && !jev.value.enable),
)
const jevMissingHint = computed(() => {
  const parts: string[] = []
  if (apiKey.value.trim() === '') parts.push('密钥')
  if (jev.value.targetDirection.trim() === '') parts.push('目标岗位方向')
  return parts.length ? `缺少：${parts.join('、')}` : ''
})

/** FR-010：密钥只进浏览器存储 `local:jev-api-key`（后台 FR-017 从同键读取），
 * 不进 FormData、不写日志；输入框失焦即提交。 */
async function saveApiKey() {
  if (apiKey.value.trim() === '') {
    await counter.storageRm(JEV_API_KEY_STORAGE_KEY)
    return
  }
  await counter.storageSet(JEV_API_KEY_STORAGE_KEY, apiKey.value)
}

onMounted(async () => {
  const stored = await counter.storageGet<string>(JEV_API_KEY_STORAGE_KEY)
  if (typeof stored === 'string') apiKey.value = stored
})

/** 开关交互：关闭直接生效；开启先弹授权确认，确认后才真正启用。 */
async function onJevSwitchClick() {
  if (jev.value.enable) {
    jev.value.enable = false
    conf.confSaving()
    return
  }
  jevConsentShow.value = true
}

async function confirmJevEnable() {
  // 弹窗打开后密钥/方向仍可能被清空：确认时重新过门控（AC-006 fail-closed）
  if (!jevCanEnable.value) {
    jevConsentShow.value = false
    return
  }
  await saveApiKey()
  jev.value.enable = true
  jevConsentShow.value = false
  conf.confSaving()
}
</script>

<template>
  <div class="flex flex-col gap-3" data-help="AI 配置">
    <div class="flex flex-wrap gap-3">
      <UFieldGroup :data-help="formInfoData.jev['data-help']">
        <UButton
          :color="jev.enable ? 'success' : 'error'"
          :disabled="jevSwitchDisabled"
          :title="jevMissingHint"
          @click="onJevSwitchClick"
        >
          {{ formInfoData.jev.label }}
        </UButton>
      </UFieldGroup>
      <FormSwitch
        :label="formInfoData.aiGreeting.label"
        :data-help="formInfoData.aiGreeting['data-help']"
        :data="conf.formData.aiGreeting"
        :lock="helper.workflow?.status.value === 'running'"
        @show="
          () => {
            aiBox = 'aiGreeting'
            aiBoxShow = true
          }
        "
        @change="change"
      />
      <FormSwitch
        :label="formInfoData.aiFiltering.label"
        :data-help="formInfoData.aiFiltering['data-help']"
        :data="conf.formData.aiFiltering"
        :lock="helper.workflow?.status.value === 'running'"
        @show="
          () => {
            aiBox = 'aiFiltering'
            aiBoxShow = true
          }
        "
        @change="change"
      />
      <FormSwitch
        :label="formInfoData.aiReply.label"
        :data-help="formInfoData.aiReply['data-help']"
        :data="conf.formData.aiReply"
        disabled
        @show="
          () => {
            aiBox = 'aiReply'
            aiBoxShow = true
          }
        "
        @change="change"
      />
      <!-- <formSwitch
      v-bind="formInfoData.record"
      :data="formData.record"
      @show="
        aiBox = 'record';
        aiBoxShow = true;
      "
      @change="change"
    /> -->
    </div>
    <div class="flex flex-col gap-3">
      <p v-if="!jevCanEnable" class="text-xs text-gray-400">{{ jevMissingHint }}，填写后才能启用</p>
      <UFormField label="Jev 密钥" class="w-full">
        <UInput
          v-model="apiKey"
          :type="apiKeyVisible ? 'text' : 'password'"
          autocomplete="off"
          placeholder="粘贴你的 Jev API 密钥"
          class="w-full"
          @blur="saveApiKey"
        >
          <template #trailing>
            <UButton
              variant="link"
              size="sm"
              :icon="apiKeyVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              :aria-label="apiKeyVisible ? '隐藏密钥' : '显示密钥'"
              @click="apiKeyVisible = !apiKeyVisible"
            />
          </template>
        </UInput>
        <p class="text-xs text-gray-400">
          密钥只写入本机浏览器存储，供扩展后台代发请求使用，不会上传、不会进入日志
        </p>
      </UFormField>
      <UFormField label="目标岗位方向" :data-help="formInfoData.jev['data-help']" class="w-full">
        <UTextarea
          v-model="jev.targetDirection"
          :rows="2"
          autoresize
          placeholder="例：只投递以前端开发为主要职责的岗位"
          class="w-full"
        />
        <p class="text-xs text-gray-400">
          Jev 以这段描述判断岗位方向；修改后已缓存的结果会失效并重新判断
        </p>
      </UFormField>
      <UAlert
        color="info"
        variant="subtle"
        :close="false"
        title="数据接收与授权（FR-010 / FR-011）"
      >
        <ul class="list-disc pl-4 text-xs leading-5">
          <li>接收服务：Jev 判断服务（{{ JEV_BASE_URL }}）</li>
          <li>发送字段：仅岗位标题与职位描述</li>
          <li>不含简历、聊天记录、账号或任何个人数据</li>
          <li>岗位文字只作为被判断内容，不扩大权限、不触发任何动作</li>
        </ul>
      </UAlert>
    </div>
    <div>
      <LLMModelManage>
        <UButton
          color="primary"
          data-help="配置需要使用的LLM大模型"
          @click="
            () => {
              aiConfBoxShow = true
            }
          "
        >
          模型配置
        </UButton>
      </LLMModelManage>
    </div>

    <UModal
      v-model:open="jevConsentShow"
      title="启用 Jev 方向判断"
      description="启用前请确认数据接收与授权内容"
    >
      <template #body>
        <ul class="list-disc pl-4 leading-6">
          <li>接收服务：Jev 判断服务（{{ JEV_BASE_URL }}）</li>
          <li>发送字段：仅岗位标题与职位描述</li>
          <li>不含简历、聊天记录、账号或任何个人数据</li>
          <li>岗位文字只作为被判断内容，不扩大权限、不触发任何动作</li>
        </ul>
      </template>
      <template #footer>
        <div class="flex flex-row gap-3 justify-end">
          <UButton color="neutral" variant="outline" @click="jevConsentShow = false">取消</UButton>
          <UButton color="primary" @click="confirmJevEnable">了解并授权启用</UButton>
        </div>
      </template>
    </UModal>

    <LLMPromptEdit
      v-if="aiBoxShow && aiBox !== 'record'"
      v-model="aiBoxShow"
      v-key="aiBox"
      :data="aiBox"
    />
  </div>
</template>
