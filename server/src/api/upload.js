'use strict'

/**
 * Multer upload middleware shared by the management API routes that accept a
 * file (`POST /api/resources`, `POST /api/edit-rules/value-file`). Files are
 * written into the storage directory under a timestamped, sanitised name.
 *
 * @module api/upload
 */

const path = require('path')
const multer = require('multer')

/**
 * Build the multer instance for the given storage directory.
 *
 * @param {string} storageDir Directory that receives the uploaded files.
 * @returns {import('multer').Multer}
 */
function createUpload(storageDir) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, storageDir)
    },
    filename: (req, file, cb) => {
      // Keep only the base name and replace characters that are unsafe in file
      // names so an upload can never escape the storage directory.
      const baseName = path.basename(file.originalname || 'upload').replace(/[^\w.-]+/g, '_')
      cb(null, `${Date.now()}-${baseName}`)
    }
  })
  return multer({ storage })
}

module.exports = { createUpload }
