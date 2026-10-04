/*
 * QR code helper around the vendored qrcode-generator library (vendor/qrcode.js, MIT).
 * Builds the module matrix and renders it as SVG (string or DOM element) or PNG. Classic script and CommonJS.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../vendor/qrcode.js'));
  } else {
    if (typeof root.qrcode !== 'function') throw new Error('The QR library is missing: load vendor/qrcode.js before js/qr.js');
    root.ArcInvoice = Object.assign(root.ArcInvoice || {}, { qr: factory(root.qrcode) });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (qrcode) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var QUIET_ZONE = 4; // modules of white border required by the QR specification

  /**
   * Encode text (as UTF-8 bytes) into a QR matrix. opts.ecc 'L' | 'M' (default 'M'). The version is chosen automatically.
   * Returns { size, version, ecc, text, modules: boolean[][] }. Throws Error with code 'TOO_LONG' if the text does not fit.
   */
  function create(text, opts) {
    var ecc = (opts && opts.ecc) || 'M';
    if (qrcode.stringToBytesFuncs && qrcode.stringToBytesFuncs['UTF-8']) qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];
    var qr;
    try {
      qr = qrcode(0, ecc);
      qr.addData(String(text), 'Byte');
      qr.make();
    } catch (e) {
      var err = new Error('This link is too long for a QR code. Shorten the description or the invoice number and try again.');
      err.code = 'TOO_LONG';
      err.cause = e;
      throw err;
    }
    var n = qr.getModuleCount();
    var modules = [];
    for (var r = 0; r < n; r++) {
      var row = [];
      for (var c = 0; c < n; c++) row.push(!!qr.isDark(r, c));
      modules.push(row);
    }
    return { size: n, version: (n - 17) / 4, ecc: ecc, text: String(text), modules: modules };
  }

  /** SVG path data: one horizontal run per row segment ("M x y h len v1 h-len z"), offset by the quiet zone. */
  function pathData(qr, margin) {
    var d = [];
    for (var y = 0; y < qr.size; y++) {
      var x = 0;
      while (x < qr.size) {
        if (!qr.modules[y][x]) {
          x++;
          continue;
        }
        var start = x;
        while (x < qr.size && qr.modules[y][x]) x++;
        d.push('M' + (start + margin) + ' ' + (y + margin) + 'h' + (x - start) + 'v1h-' + (x - start) + 'z');
      }
    }
    return d.join('');
  }

  /**
   * Standalone SVG document text (for download or print). Black on white with a quiet zone, scalable.
   * opts: { margin (modules, default 4), scale (px per module for width/height, default 6), title }
   */
  function toSvgString(qr, opts) {
    var margin = opts && opts.margin !== undefined ? opts.margin : QUIET_ZONE;
    var scale = (opts && opts.scale) || 6;
    var dim = qr.size + margin * 2;
    var title = (opts && opts.title) || 'QR code';
    var safeTitle = String(title).replace(/[<>&"]/g, '');
    return (
      '<svg xmlns="' + SVG_NS + '" viewBox="0 0 ' + dim + ' ' + dim + '" width="' + dim * scale + '" height="' + dim * scale +
      '" shape-rendering="crispEdges" role="img" aria-label="' + safeTitle + '">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#ffffff"/>' +
      '<path fill="#000000" d="' + pathData(qr, margin) + '"/></svg>'
    );
  }

  /** The same picture as a DOM element (built with createElementNS, no HTML parsing). */
  function toSvgElement(qr, opts) {
    var margin = opts && opts.margin !== undefined ? opts.margin : QUIET_ZONE;
    var dim = qr.size + margin * 2;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + dim + ' ' + dim);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', (opts && opts.title) || 'QR code');
    var bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('width', String(dim));
    bg.setAttribute('height', String(dim));
    bg.setAttribute('fill', '#ffffff');
    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', '#000000');
    path.setAttribute('d', pathData(qr, margin));
    svg.appendChild(bg);
    svg.appendChild(path);
    return svg;
  }

  /** PNG as a Blob (canvas). opts: { scale px per module (default 8), margin modules (default 4) }. Browser only. */
  function toPngBlob(qr, opts) {
    var margin = opts && opts.margin !== undefined ? opts.margin : QUIET_ZONE;
    var scale = (opts && opts.scale) || 8;
    return new Promise(function (resolve, reject) {
      var canvas = document.createElement('canvas');
      var px = (qr.size + margin * 2) * scale;
      canvas.width = px;
      canvas.height = px;
      var ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas is not available in this browser.'));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, px, px);
      ctx.fillStyle = '#000000';
      for (var y = 0; y < qr.size; y++) {
        for (var x = 0; x < qr.size; x++) {
          if (qr.modules[y][x]) ctx.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
        }
      }
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Could not create the PNG.'));
      }, 'image/png');
    });
  }

  return { QUIET_ZONE: QUIET_ZONE, create: create, toSvgString: toSvgString, toSvgElement: toSvgElement, toPngBlob: toPngBlob };
});
