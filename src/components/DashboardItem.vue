<template>
  <div class="p-5 bg-white rounded-xl shadow-sm border border-gray-100 flex flex-col h-full">
    <div class="flex justify-between items-center mb-4">
      <h3 class="text-base font-semibold text-gray-700 truncate">{{ item.name }}</h3>
      
      <div v-if="item.allow_toggle_view" class="inline-flex rounded-md shadow-sm bg-gray-100 p-0.5">
        <button 
          @click="currentView = 'chart'"
          :class="currentView === 'chart' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
          class="px-2.5 py-1 text-xs font-medium rounded-md transition-all"
        >
          Chart
        </button>
        <button 
          @click="currentView = 'table'"
          :class="currentView === 'table' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'"
          class="px-2.5 py-1 text-xs font-medium rounded-md transition-all"
        >
          Table
        </button>
      </div>
    </div>

    <div class="flex-grow flex items-center justify-center min-h-[300px]">
      <div v-if="currentView === 'chart'" class="w-full">
        <apexchart 
          :type="item.chart_type" 
          :options="chartOptions" 
          :series="chartSeries" 
          height="320"
        />
      </div>

      <div v-else class="w-full max-h-[320px] overflow-auto">
        <DataTable :value="rawData" :rows="5" paginator class="p-datatable-sm text-sm" responsiveLayout="scroll">
          <Column v-for="col in tableColumns" :key="col" :field="col" :header="formatHeader(col)" sortable />
        </DataTable>
      </div>
    </div>

    <Sidebar v-model:visible="drawerVisible" position="right" class="w-full md:w-[45rem]">
      <template #header>
        <div class="flex flex-col">
          <span class="text-xl font-bold text-gray-800">Detail Breakdown Data</span>
          <span class="text-sm text-gray-400 mt-1">Filter terapan: {{ JSON.stringify(activeFilters) }}</span>
        </div>
      </template>
      
      <DataTable :value="drawerData" :rows="10" paginator class="p-datatable-striped mt-4" responsiveLayout="scroll">
        <Column v-for="col in drawerColumns" :key="col" :field="col" :header="formatHeader(col)" sortable />
      </DataTable>
    </Sidebar>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useDashboardStore } from '../store/dashboard';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import Sidebar from 'primevue/sidebar';

const props = defineProps({
  item: Object
});

const store = useDashboardStore();
const currentView = ref('chart');
const rawData = ref([]);

// State untuk Drawer Detail
const drawerVisible = ref(false);
const drawerData = ref([]);
const activeFilters = ref({});

// Deteksi jika ada suntikan data real-time baru dari store Pinia
watch(() => props.item.realtimeData, (newData) => {
  if (newData) rawData.value = newData;
}, { deep: true });

// Ambil data pertama kali saat komponen dimuat (jika Odoo belum mem-push data)
onMounted(async () => {
  try {
    rawData.value = await store.getChartData(props.item.id);
  } catch (err) {
    console.error("Gagal memuat data komponen:", err);
  }
});

// Otomatis mengenali nama kolom dari kueri database Odoo
const tableColumns = computed(() => rawData.value.length > 0 ? Object.keys(rawData.value[0]) : []);
const drawerColumns = computed(() => drawerData.value.length > 0 ? Object.keys(drawerData.value[0]) : []);

const formatHeader = (text) => text.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// PARSER UTAMA: Mengubah baris SQL menjadi format Series & Options ApexCharts
const chartOptions = computed(() => {
  // Ambil kolom pertama hasil query sebagai sumbu X (Kategori / Kunci Utama)
  const xKey = tableColumns.value[0] || 'category';
  const categories = rawData.value.map(row => row[xKey]);

  return {
    chart: {
      id: `chart-${props.item.id}`,
      toolbar: { show: true },
      events: {
        dataPointSelection: (event, chartContext, config) => {
          handleChartClick(config, xKey);
        }
      }
    },
    xaxis: { categories: categories },
    labels: categories, // Fallback untuk tipe chart Pie / Donut / RadialBar
    dataLabels: { enabled: ['pie', 'donut', 'radialBar'].includes(props.item.chart_type) }
  };
});

const chartSeries = computed(() => {
  if (rawData.value.length === 0) return [];
  const xKey = tableColumns.value[0];
  
  // Jika kolom query lebih dari 2, berarti kueri didesain untuk tipe stacked/multi-series
  // Kolom ke-2 adalah penanda nama series, Kolom ke-3 adalah nilainya
  if (tableColumns.value.length > 2) {
    const seriesKey = tableColumns.value[1];
    const valueKey = tableColumns.value[2];
    
    // Kelompokkan data berdasarkan nama series unik
    const uniqueSeriesNames = [...new Set(rawData.value.map(row => row[seriesKey]))];
    return uniqueSeriesNames.map(name => {
      return {
        name: name,
        data: rawData.value.filter(row => row[seriesKey] === name).map(row => row[valueKey])
      };
    });
  }

  // Standard Single Series (Kolom ke-2 adalah nilai numeriknya)
  const yKey = tableColumns.value[1] || 'value';
  return [{
    name: formatHeader(yKey),
    data: rawData.value.map(row => row[yKey])
  }];
});

// PENANGAN ACTION KLIK MULTI-FILTER APEXCHARTS
async function handleChartClick(config, xKey) {
  const xValue = config.w.config.xaxis.categories[config.dataPointIndex] || config.w.config.labels[config.dataPointIndex];
  if (!xValue) return;

  const filters = {};
  filters[xKey] = xValue; // Masukkan filter sumbu X utama (misal: { bulan: '2026-03' })

  // Jika grafik memiliki multi-series (grafik bertingkat/stacked)
  if (tableColumns.value.length > 2) {
    const seriesKey = tableColumns.value[1];
    const seriesName = config.w.config.series[config.seriesIndex].name;
    filters[seriesKey] = seriesName; // Masukkan filter kedua (misal: { kategori: 'Office Supplies' })
  }

  activeFilters.value = filters;

  try {
    // Tarik kueri detail drawer dari Node.js bawa JSON multi-filter
    drawerData.value = await store.getChartDetail(props.item.id, filters);
    drawerVisible.value = true; // Buka Drawer PrimeVue
  } catch (err) {
    console.error("Gagal memuat detail drilldown:", err);
  }
}
</script>