import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io } from 'socket.io-client';

export const useDashboardStore = defineStore('dashboard', () => {
  // Hubungkan ke Node.js Bridge Server Anda
  const socket = io('http://localhost:3000'); 
  
  const currentPageName = ref('');
  const dashboardItems = ref([]);
  const isLoading = ref(false);
  const errorMessage = ref('');

  // Dummy user ID Odoo (Pada sistem asli, ambil dari store auth/login Anda)
  const currentUserId = ref(2); 

  function fetchDashboardLayout(slug) {
    isLoading.value = true;
    errorMessage.value = '';
    
    // Minta data layout ke Node.js berdasarkan Slug URL
    socket.emit('get_dashboard_layout', { 
      slug: slug, 
      userId: currentUserId.value 
    }, (response) => {
      isLoading.value = false;
      
      if (response.success) {
        currentPageName.value = response.page_name;
        dashboardItems.value = response.items;
        
        // Mulai dengarkan event real-time khusus untuk item-item di halaman ini
        setupRealtimeListeners();
      } else {
        errorMessage.value = response.error;
      }
    });
  }

  function setupRealtimeListeners() {
    dashboardItems.value.forEach(item => {
      // Dengarkan jika Odoo mem-push data update spesifik untuk ID item ini
      socket.off(`chart_refresh:${item.id}`); // Bersihkan listener lama (anti-leak)
      socket.on(`chart_refresh:${item.id}`, (pushData) => {
        const index = dashboardItems.value.findIndex(i => i.id === item.id);
        if (index !== -1) {
          // Suntikkan data baru dari Odoo secara langsung ke dalam state
          // Komponen Vue akan otomatis mendeteksi perubahan dan me-render ulang grafik!
          dashboardItems.value[index].realtimeData = pushData.chart_data;
        }
      });
    });
  }

  // Helper kirim request kueri ke Node.js untuk data awal grafik
  function getChartData(itemId) {
    return new Promise((resolve, reject) => {
      socket.emit('get_chart_data', { itemId }, (res) => {
        if (res.success) resolve(res.data);
        else reject(res.error);
      });
    });
  }

  // Helper kirim request data detail multi-filter ke Node.js (untuk Drawer)
  function getChartDetail(itemId, filters) {
    return new Promise((resolve, reject) => {
      socket.emit('get_chart_detail_multi', { itemId, filters }, (res) => {
        if (res.success) resolve(res.data);
        else reject(res.error);
      });
    });
  }

  return {
    currentPageName,
    dashboardItems,
    isLoading,
    errorMessage,
    fetchDashboardLayout,
    getChartData,
    getChartDetail
  };
});