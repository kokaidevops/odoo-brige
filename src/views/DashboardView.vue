<template>
  <div class="min-h-screen bg-gray-50 p-6">
    <div class="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between border-b border-gray-200 pb-5 mb-6">
      <div>
        <h1 class="text-2xl font-bold tracking-tight text-gray-900">
          {{ store.currentPageName || 'Loading Dashboard...' }}
        </h1>
        <p class="mt-1 text-sm text-gray-500">Headless BI Real-time Platform connected to Odoo 16</p>
      </div>
    </div>

    <div class="max-w-7xl mx-auto text-center py-20" v-if="store.isLoading">
      <p class="text-gray-500 text-lg">Mengambil konfigurasi layout dari Odoo...</p>
    </div>

    <div class="max-w-7xl mx-auto bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg" v-else-if="store.errorMessage">
      <div class="font-semibold">Akses Ditolak</div>
      <div class="text-sm mt-1">{{ store.errorMessage }}</div>
    </div>

    <div class="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6" v-else>
      <div 
        v-for="item in store.dashboardItems" 
        :key="item.id" 
        :class="['pie', 'donut', 'radialBar'].includes(item.chart_type) ? 'col-span-1' : 'col-span-1 md:col-span-2 lg:col-span-3'"
        class="transition-transform duration-200 hover:translate-y-[-2px]"
      >
        <DashboardItem :item="item" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useDashboardStore } from '../store/dashboard';
import DashboardItem from '../components/DashboardItem.vue';

const route = useRoute();
const store = useDashboardStore();

// Muat ulang data layout otomatis setiap kali user pindah halaman slug URL
onMounted(() => {
  store.fetchDashboardLayout(route.params.slug);
});

watch(() => route.params.slug, (newSlug) => {
  if (newSlug) store.fetchDashboardLayout(newSlug);
});
</script>