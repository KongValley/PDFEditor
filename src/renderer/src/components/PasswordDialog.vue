<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { passwordState, submitPassword } from '../store/ui'

const value = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  () => passwordState.open,
  async (open) => {
    if (!open) return
    value.value = ''
    await nextTick()
    inputEl.value?.focus()
  }
)

function confirm(): void {
  submitPassword(value.value)
}

function cancel(): void {
  submitPassword(null)
}
</script>

<template>
  <div v-if="passwordState.open" class="mask">
    <div class="dialog">
      <div class="title">需要密码</div>
      <div class="message">{{ passwordState.message }}</div>
      <input
        ref="inputEl"
        v-model="value"
        type="password"
        placeholder="请输入文档密码"
        @keydown.enter="confirm"
        @keydown.esc="cancel"
      />
      <div class="actions">
        <button @click="cancel">取消</button>
        <button class="primary" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(20, 23, 30, 0.6);
  z-index: 300;
}

.dialog {
  width: 320px;
  padding: 16px;
  border-radius: 8px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.title {
  font-weight: 600;
}

.message {
  color: var(--toolbar-fg-dim);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

button.primary {
  background: var(--accent);
  color: #fff;
}
</style>
