/*
 * Copyright 2016 resin.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const _ = require('lodash')
const Bluebird = require('bluebird')
const path = require('path')
const semver = require('semver');
const { ipcRenderer, remote } = require('electron')

const messages = require('../../../../shared/messages')
const errors = require('../../../../shared/errors')
const imageStream = require('../../../../image-stream')
const supportedFormats = require('../../../../shared/supported-formats')
const analytics = require('../../../modules/analytics')
const selectionState = require('../../../../shared/models/selection-state')
const osDialog = require('../../../os/dialog')
const exceptionReporter = require('../../../modules/exception-reporter')
const fs = require('mz/fs')

module.exports = function (
  $timeout,
  WarningModalService
) {
  // Flag for if we have started to download the mcu .img.zip file
  this.downloading = false
  this.availableVersion = null
  this.currentVersion = null

  this.init = () => {
    this.checkForNewImage()

    ipcRenderer.on('download-mcu', (event, arg) => {
      this.downloading = false
      if (arg.error == null) {
        this.selectImageByPath(arg.imagePath)
        this.checkForNewImage()
      }
    })
  }

  this.isDownloading = () => {
    return this.downloading
  }

  /**
   * @summary Main supported extensions
   * @constant
   * @type {String[]}
   * @public
   */
  this.mainSupportedExtensions = _.intersection([
    'img',
    'iso',
    'zip'
  ], supportedFormats.getAllExtensions())

  /**
   * @summary Extra supported extensions
   * @constant
   * @type {String[]}
   * @public
   */
  this.extraSupportedExtensions = _.difference(
    supportedFormats.getAllExtensions(),
    this.mainSupportedExtensions
  ).sort()

  /**
   * @summary Select image
   * @function
   * @public
   *
   * @param {Object} image - image
   *
   * @example
   * osDialogService.selectImage()
   *   .then(ImageSelectionController.selectImage);
   */
  this.selectImage = (image) => {
    if (!supportedFormats.isSupportedImage(image.path)) {
      const invalidImageError = errors.createUserError({
        title: 'Invalid image',
        description: messages.error.invalidImage({
          image
        })
      })

      osDialog.showError(invalidImageError)
      analytics.logEvent('Invalid image', image)
      return
    }

    Bluebird.try(() => {
      let message = null

      if (supportedFormats.looksLikeWindowsImage(image.path)) {
        analytics.logEvent('Possibly Windows image', image)
        message = messages.warning.looksLikeWindowsImage()
      } else if (!image.hasMBR) {
        analytics.logEvent('Missing partition table', image)
        message = messages.warning.missingPartitionTable()
      }

      if (message) {
        // TODO: `Continue` should be on a red background (dangerous action) instead of `Change`.
        // We want `X` to act as `Continue`, that's why `Continue` is the `rejectionLabel`
        return WarningModalService.display({
          confirmationLabel: 'Change',
          rejectionLabel: 'Continue',
          description: message
        })
      }

      return false
    }).then((shouldChange) => {
      if (shouldChange) {
        return this.reselectImage()
      }

      selectionState.setImage(image)

      // An easy way so we can quickly identify if we're making use of
      // certain features without printing pages of text to DevTools.
      image.logo = Boolean(image.logo)
      image.bmap = Boolean(image.bmap)

      return analytics.logEvent('Select image', image)
    }).catch(exceptionReporter.report)
  }

  /**
   * @summary Select an image by path
   * @function
   * @public
   *
   * @param {String} imagePath - image path
   *
   * @example
   * ImageSelectionController.selectImageByPath('path/to/image.img');
   */
  this.selectImageByPath = (imagePath) => {
    imageStream.getImageMetadata(imagePath)
      .then((imageMetadata) => {
        $timeout(() => {
          this.selectImage(imageMetadata)
        })
      })
      .catch((error) => {
        const imageError = errors.createUserError({
          title: 'Error opening image',
          description: messages.error.openImage({
            imageBasename: path.basename(imagePath),
            errorMessage: error.message
          })
        })

        osDialog.showError(imageError)
        analytics.logException(error)
      })
  }

  /**
   * @summary Ping github to see if a newer MCU image is available
   * Scan the download directory and compare the newest image online
   * against the most recently downloaded image
   *
   * If no mcu images downloaded, highlight the update prompt button
   * If mcu image out of date, allow the update prompt button to work
   * If mcu image up to date, set the image
   * @function
   * @public
   *
   * @example
   * ImageSelectionController.checkForNewImage();
   */
  this.checkForNewImage = (allowDownload = false) => {
    // Query github for the latest mcu image
    // If it's not available, activate button to allow download of the image
    const headers = new Headers()
    headers.append('pragma', 'no-cache')
    headers.append('cache-control', 'no-cache')
    const fetcher = {
      method: 'GET',
      headers
    }

    const request = new Request('http://api.github.com/repos/autodesk/machine-collaboration-utility/releases/latest')
    fetch(request, fetcher)
    .then(reply => reply.json())
    .catch(err => {
      return null
    })
    .then(json => {
      let newest = null;
      if (json != null && json.assets && json.assets.length > 0) {
        newest = json.tag_name
        this.availableVersion = newest
      }

      try {
        const dirs = fs.readdirSync(remote.app.getPath('downloads'))
        // The first file in this array is the most up to date image
        const mcuImages = dirs.filter(file => file.match(/^mcu_v\d+\.\d+\.\d+\.img\.zip$/)).sort().reverse()

        let newImageAvailable = true
        // If new image is higher, prompt to download it
        if (mcuImages.length > 0) {
          const latestDownload = mcuImages[0].replace('mcu_', '').replace('.img.zip', '');
          this.currentVersion = latestDownload
          newImageAvailable = this.updateAvailable()
        }

        if (mcuImages.length > 0) {
          const imagePath = path.join(remote.app.getPath('downloads'), mcuImages[0])
          this.selectImageByPath(imagePath)
        }

        if (newImageAvailable && allowDownload) {
          this.downloading = true
          ipcRenderer.send('download-mcu', json.assets[0].browser_download_url)
        }
      } catch (ex) {
        console.error('Select image error', ex);
      }
    })
    .catch(err => {
      // Need to handle if offline or if the endpoint has failed
      console.error(err)
    })
  }

  this.downloadPrompt = () => {
    if (this.downloading) {
      return 'Downloading...'
    }

    return "Download " + this.availableVersion
  }

  this.updateAvailable = () => {
    if (this.availableVersion && this.currentVersion && semver.compare(this.availableVersion, this.currentVersion) > 0) {
      return true
    }
    return false
  }

  // /**
  //  * @summary Open image selector
  //  * @function
  //  * @public
  //  *
  //  * @example
  //  * ImageSelectionController.openImageSelector();
  //  */
  // this.openImageSelector = () => {
  //   analytics.logEvent('Open image selector')

  //   osDialog.selectImage().then((imagePath) => {
  //     // Avoid analytics and selection state changes
  //     // if no file was resolved from the dialog.
  //     if (!imagePath) {
  //       analytics.logEvent('Image selector closed')
  //       return
  //     }

  //     this.selectImageByPath(imagePath)
  //   }).catch(exceptionReporter.report)
  // }

  /**
   * @summary Reselect image
   * @function
   * @public
   *
   * @example
   * ImageSelectionController.reselectImage();
   */
  this.reselectImage = () => {
    analytics.logEvent('Reselect image', {
      previousImage: selectionState.getImage()
    })

    this.openImageSelector()
  }

  /**
   * @summary Get the basename of the selected image
   * @function
   * @public
   *
   * @returns {String} basename of the selected image
   *
   * @example
   * const imageBasename = ImageSelectionController.getImageBasename();
   */
  this.getImageBasename = () => {
    if (!selectionState.hasImage()) {
      return ''
    }

    return path.basename(selectionState.getImagePath())
  }

  this.init();
}
