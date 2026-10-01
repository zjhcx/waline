const scripts = new Map();

export const useCap = () => {
  return async () => {
    const endpoint = window.capApiEndpoint;
    const scriptUrl = window.capWidgetUrl;
    const src = scriptUrl || 'https://cdn.jsdelivr.net/npm/cap-widget@0.1.58/cap.min.js';
    if (!window.Cap) {
      let loading = scripts.get(src);
      if (!loading) {
        loading = new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.async = true;
          script.onload = () => resolve();
          script.onerror = () => {
            scripts.delete(src);
            script.remove();
            reject(new Error('Cap script could not be loaded'));
          };
          document.head.append(script);
        });
        scripts.set(src, loading);
      }
      await loading;
    }
    if (!window.Cap) throw new Error('Cap script not available');
    const cap = new window.Cap({ apiEndpoint: `${endpoint.replace(/\/+$/u, '')}/` });
    try {
      const result = await cap.solve();
      if (!result.token) throw new Error('Cap verification failed');
      return result.token;
    } finally {
      cap.reset();
      cap.widget.remove();
    }
  };
};
