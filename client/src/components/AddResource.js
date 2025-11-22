import React, { useState } from 'react';
import { 
  Upload, 
  FileText, 
  Link as LinkIcon,
  CheckCircle,
  AlertCircle,
  Code
} from 'lucide-react';
import axios from 'axios';

/**
 * Form for creating a new local resource override.
 *
 * Users can bind either a file or raw text content to a given URL pattern so that
 * matching requests are served locally instead of hitting the upstream server.
 *
 * @param {Object} props
 * @param {() => void} props.onSuccess Callback invoked after a resource is successfully created.
 */
function AddResource({ onSuccess }) {
  const [mode, setMode] = useState('file'); // 'file' or 'text'
  const [url, setUrl] = useState('');
  const [file, setFile] = useState(null);
  const [textContent, setTextContent] = useState('');
  const [contentType, setContentType] = useState('text/plain');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const handleFileChange = (e) => {
    const selectedFile = e.target.files[0];
    if (selectedFile) {
      setFile(selectedFile);
      // Auto-detect content type
      if (!contentType || contentType === 'text/plain') {
        setContentType(selectedFile.type || 'application/octet-stream');
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!url) {
      setError('L\'URL è obbligatorio');
      return;
    }

    if (mode === 'file' && !file) {
      setError('Select a file to upload');
      return;
    }

    if (mode === 'text' && !textContent) {
      setError('Inserisci il contenuto testuale');
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      formData.append('url', url);
      formData.append('contentType', contentType);

      if (mode === 'file') {
        formData.append('file', file);
      } else {
        formData.append('content', textContent);
      }

      await axios.post('/api/resources', formData, {
        headers: {
          'Content-Type': 'multipart/form-data'
        }
      });

      setSuccess('Resource added successfully!');
      
      // Reset form
      setTimeout(() => {
        setUrl('');
        setFile(null);
        setTextContent('');
        setContentType('text/plain');
        setSuccess('');
        onSuccess();
      }, 1500);
    } catch (err) {
      setError(err.response?.data?.error || 'Error uploading resource');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <div className="bg-[#1a1a1a] rounded-lg border border-[#2a2a2a] p-6">
        <div className="flex items-center space-x-3 mb-6">
          <Upload className="w-6 h-6 text-blue-400" />
          <div>
            <h3 className="text-xl font-semibold text-white">Add Local Resource</h3>
            <p className="text-sm text-slate-400">
              Upload a file or insert text content to override a remote resource
            </p>
          </div>
        </div>

        {/* Mode Selection */}
        <div className="flex space-x-2 mb-6">
          <button
            type="button"
            onClick={() => setMode('file')}
            className={`flex-1 h-8 px-4 rounded-lg text-xs font-medium transition-colors border ${
              mode === 'file'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-[#0a0a0a] text-slate-400 border-[#2a2a2a] hover:border-blue-500 hover:text-blue-400'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <Upload className="w-4 h-4" />
              <span>Upload File</span>
            </div>
          </button>
          
          <button
            type="button"
            onClick={() => setMode('text')}
            className={`flex-1 h-8 px-4 rounded-lg text-xs font-medium transition-colors border ${
              mode === 'text'
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-[#0a0a0a] text-slate-400 border-[#2a2a2a] hover:border-blue-500 hover:text-blue-400'
            }`}
          >
            <div className="flex items-center justify-center space-x-2">
              <Code className="w-4 h-4" />
              <span>Contenuto Testuale</span>
            </div>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* URL Input */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              <div className="flex items-center space-x-2">
                <LinkIcon className="w-4 h-4" />
                <span>URL da intercettare</span>
              </div>
            </label>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="es: /api/data.json o https://example.com/api/data.json"
              className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
              required
            />
            <p className="mt-2 text-xs text-slate-400">
              Enter the full or partial URL you want to intercept. Requests containing this URL will serve the local resource.
            </p>
          </div>

          {/* Content Type */}
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">
              Content Type
            </label>
            <select
              value={contentType}
              onChange={(e) => setContentType(e.target.value)}
              className="w-full px-3 h-8 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="text/plain">text/plain</option>
              <option value="text/html">text/html</option>
              <option value="application/json">application/json</option>
              <option value="application/javascript">application/javascript</option>
              <option value="text/css">text/css</option>
              <option value="image/jpeg">image/jpeg</option>
              <option value="image/png">image/png</option>
              <option value="image/gif">image/gif</option>
              <option value="image/svg+xml">image/svg+xml</option>
              <option value="application/octet-stream">application/octet-stream</option>
            </select>
          </div>

          {/* File Upload Mode */}
          {mode === 'file' && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                <div className="flex items-center space-x-2">
                  <Upload className="w-4 h-4" />
                  <span>File to upload</span>
                </div>
              </label>
              <div className="relative">
                <input
                  type="file"
                  id="file-upload"
                  onChange={handleFileChange}
                  className="hidden"
                  required
                />
                <label
                  htmlFor="file-upload"
                  className="flex items-center justify-center w-full px-4 py-3 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-slate-400 hover:border-blue-500 hover:text-blue-400 cursor-pointer transition-colors"
                >
                  <Upload className="w-4 h-4 mr-2" />
                  <span>{file ? file.name : 'Scegli un file...'}</span>
                </label>
              </div>
              {file && (
                <p className="mt-2 text-sm text-green-400">
                  File selezionato: {file.name} ({(file.size / 1024).toFixed(2)} KB)
                </p>
              )}
            </div>
          )}

          {/* Text Content Mode */}
          {mode === 'text' && (
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                <div className="flex items-center space-x-2">
                  <FileText className="w-4 h-4" />
                  <span>Contenuto</span>
                </div>
              </label>
              <textarea
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                placeholder="Inserisci il contenuto testuale, JSON, HTML, ecc..."
                rows={12}
                className="w-full px-3 py-2 bg-[#0a0a0a] border border-[#2a2a2a] rounded-lg text-xs text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 font-mono resize-none"
                required
              />
              <p className="mt-2 text-xs text-slate-400">
                {textContent.length} caratteri
              </p>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div className="flex items-center space-x-2 p-4 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <p className="text-sm">{error}</p>
            </div>
          )}

          {/* Success Message */}
          {success && (
            <div className="flex items-center space-x-2 p-4 bg-green-500/20 border border-green-500/30 rounded-lg text-green-400">
              <CheckCircle className="w-5 h-5 flex-shrink-0" />
              <p className="text-sm">{success}</p>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            className="w-full h-8 px-4 rounded-lg bg-blue-600/20 border border-blue-500/40 text-blue-300 hover:bg-blue-600/30 hover:text-white disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600/50 transition-colors flex items-center justify-center gap-2 text-xs font-medium"
          >
            {loading ? (
              <>
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                <span>Uploadmento...</span>
              </>
            ) : (
              <>
                <Upload className="w-5 h-5" />
                <span>Add Resource</span>
              </>
            )}
          </button>
        </form>
      </div>

      {/* Info Box */}
      <div className="mt-6 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg p-4">
        <h4 className="text-slate-300 font-semibold mb-2 flex items-center space-x-2">
          <AlertCircle className="w-4 h-4 text-blue-400" />
          <span>Come funziona</span>
        </h4>
        <ul className="text-sm text-slate-400 space-y-1 ml-6 list-disc">
          <li>Inserisci l'URL che vuoi intercettare (può essere parziale)</li>
          <li>Upload un file o inserisci contenuto testuale</li>
          <li>When a request contains the specified URL, the local resource will be served</li>
          <li>Le richieste che non corrispondono verranno inoltrate normalmente</li>
        </ul>
      </div>
    </div>
  );
}

export default AddResource;
