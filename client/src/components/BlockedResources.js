import React, { useState, useEffect, useCallback } from 'react';
import { Ban, Trash2 } from 'lucide-react';

function BlockedResources() {
  const [blockedUrls, setBlockedUrls] = useState([]);

  const fetchBlockedUrls = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:8080/api/blocked');
      const data = await response.json();
      setBlockedUrls(data);
    } catch (error) {
      console.error('Error fetching blocked URLs:', error);
    }
  }, []);

  useEffect(() => {
    fetchBlockedUrls();
  }, [fetchBlockedUrls]);

  const unblockUrl = useCallback(async (url) => {
    try {
      const response = await fetch('http://localhost:8080/api/blocked', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, action: 'remove' })
      });
      
      if (response.ok) {
        await fetchBlockedUrls();
      }
    } catch (error) {
      console.error('Error unblocking URL:', error);
    }
  }, [fetchBlockedUrls]);

  return (
    <div className="space-y-4">
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
        <div className="flex items-center space-x-3">
          <div className="bg-orange-500/20 p-2 rounded-lg">
            <Ban className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Blocked Resources</h3>
            <p className="text-sm text-slate-400">
              {blockedUrls.length} {blockedUrls.length === 1 ? 'blocked resource' : 'blocked resources'}
            </p>
          </div>
        </div>
      </div>

      <div>
        {blockedUrls.length === 0 ? (
          <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] text-center">
            <Ban className="w-16 h-16 text-slate-600 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-white mb-2">Nessuna blocked resource</h3>
            <p className="text-slate-400 mb-6">
              Block URLs from logs to prevent them from loading
            </p>
          </div>
        ) : (
          <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
            <div className="space-y-2">
              {blockedUrls.map((url, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-4 bg-[#0a0a0a] rounded-lg border border-[#2a2a2a] hover:border-orange-500/50 transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-4">
                    <p className="text-sm text-slate-300 font-mono truncate">{url}</p>
                  </div>
                  <button
                    onClick={() => unblockUrl(url)}
                    className="flex items-center space-x-2 px-4 py-2 bg-[#0a0a0a] border-2 border-red-600 text-red-400 hover:bg-red-600 hover:text-white rounded-lg transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>Sblocca</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default BlockedResources;
