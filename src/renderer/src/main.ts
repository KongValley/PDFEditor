import { createApp } from 'vue'
import App from './App.vue'
import './assets/base.css'
import { installTestApi } from './test-api'

createApp(App).mount('#app')
installTestApi()
