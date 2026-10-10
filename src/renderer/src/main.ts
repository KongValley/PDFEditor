import { createApp } from 'vue'
import App from './App.vue'
import './assets/base.css'
import { installTestApi } from './test-api'
import { installLogErrorHooks } from './lib/log'
import { loadMachineProfile } from './store/document'
import { applyRenderGateBudget } from './store/viewer'

installLogErrorHooks()
const app = createApp(App)
app.mount('#app')
installTestApi()
void loadMachineProfile().then(() => applyRenderGateBudget())
