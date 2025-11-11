import React from 'react';
import { 
  Trash2, 
  FileText, 
  Image, 
  File,
  Calendar,
  HardDrive,
  Link as LinkIcon
} from 'lucide-react';

function LocalResources({ resources, onDelete, onRefresh }) {
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  const getFileIcon = (contentType) => {
    if (contentType.startsWith('image/')) {
      return <Image className="w-5 h-5 text-purple-400" />;
    } else if (contentType.includes('json') || contentType.includes('javascript')) {
      return <FileText className="w-5 h-5 text-blue-400" />;
    } else if (contentType.includes('text')) {
      return <FileText className="w-5 h-5 text-green-400" />;
    }
    return <File className="w-5 h-5 text-slate-400" />;
  };

  const getContentTypeBadge = (contentType) => {
    if (contentType.startsWith('image/')) {
      return 'bg-purple-500/20 text-purple-400 border-purple-500/30';
    } else if (contentType.includes('json')) {
      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    } else if (contentType.includes('javascript')) {
      return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    } else if (contentType.includes('html')) {
      return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    } else if (contentType.includes('text')) {
      return 'bg-green-500/20 text-green-400 border-green-500/30';
    }
    return 'bg-slate-500/20 text-slate-400 border-slate-500/30';
  };

  return (
    <div className="space-y-4">
      <div className="bg-[#1a1a1a] rounded-lg p-4 border border-[#2a2a2a]">
        <div className="flex items-center space-x-3">
          <div className="bg-blue-500/20 p-2 rounded-lg">
            <HardDrive className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-white">Risorse Locali</h3>
            <p className="text-sm text-slate-400">
              {resources.length} {resources.length === 1 ? 'resource loaded' : 'resources loaded'}
            </p>
          </div>
        </div>
      </div>

      {resources.length === 0 ? (
        <div className="bg-[#1a1a1a] rounded-lg p-12 border border-[#2a2a2a] text-center">
          <HardDrive className="w-16 h-16 text-slate-600 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">No local resources</h3>
          <p className="text-slate-400 mb-6">
            Upload file o contenuti per sovrascrivere le risorse remote
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {resources.map((resource) => (
            <div
              key={resource.url}
              className="bg-[#0a0a0a] rounded-lg border border-[#2a2a2a] p-4 hover:border-blue-500/50 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start space-x-4 flex-1 min-w-0">
                  <div className="flex-shrink-0 mt-1">
                    {getFileIcon(resource.contentType)}
                  </div>
                  
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-2 mb-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium border ${getContentTypeBadge(resource.contentType)}`}>
                        {resource.contentType}
                      </span>
                      <span className="px-2 py-1 rounded text-xs font-medium border bg-slate-500/20 text-slate-400 border-slate-500/30">
                        {formatBytes(resource.size)}
                      </span>
                    </div>
                    
                    <div className="flex items-start space-x-2 mb-2">
                      <LinkIcon className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                      <p className="text-white font-mono text-sm break-all">
                        {resource.url}
                      </p>
                    </div>
                    
                    <p className="text-slate-400 text-xs mb-1">
                      File: {resource.originalName || resource.filename}
                    </p>
                    
                    <div className="flex items-center space-x-2 text-xs text-slate-500">
                      <Calendar className="w-3 h-3" />
                      <span>
                        Uploadto il {new Date(resource.createdAt).toLocaleString('it-IT')}
                      </span>
                    </div>
                  </div>
                </div>
                
                <button
                  onClick={() => onDelete(resource.url)}
                  className="ml-4 p-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors flex-shrink-0"
                  title="Delete resource"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default LocalResources;
