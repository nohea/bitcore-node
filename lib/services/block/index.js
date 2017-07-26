'use strict';

var async = require('async');
var BaseService = require('../../service');
var inherits = require('util').inherits;
var Encoding = require('./encoding');
var index = require('../../');
var log = index.log;
var utils = require('../../utils');
var assert = require('assert');
var constants = require('../../constants');

var BlockService = function(options) {

  BaseService.call(this, options);

  this._tip = null;
  this._p2p = this.node.services.p2p;
  this._db = this.node.services.db;
  this._header = this.node.services.header;

  this._subscriptions = {};
  this._subscriptions.block = [];
  this._subscriptions.reorg = [];

  this._unprocessedBlocks = [];

  this._blockCount = 0;
  this.GENESIS_HASH = constants.BITCOIN_GENESIS_HASH[this.node.getNetworkName()];
};

inherits(BlockService, BaseService);

BlockService.dependencies = [ 'p2p', 'db', 'header' ];

BlockService.MAX_BLOCKS = 1;

// --- public prototype functions
BlockService.prototype.getAPIMethods = function() {
  var methods = [
    ['getBlock', this, this.getBlock, 1],
    ['getRawBlock', this, this.getRawBlock, 1],
    ['getBlockOverview', this, this.getBlockOverview, 1],
    ['getBestBlockHash', this, this.getBestBlockHash, 0]
  ];
  return methods;
};

BlockService.prototype.getBestBlockHash = function() {
  var headers = this._header.getAllHeaders();
  return headers[headers.length - 1].hash;
};

BlockService.prototype.getBlock = function(arg, callback) {

  var hash = this._getHash(arg);

  if (!hash) {
    return callback();
  }

  this._getBlock(hash, callback);
};

BlockService.prototype.getBlockOverview = function(hash, callback) {

  this._getBlock(hash, function(err, block) {

    if (err) {
      return callback(err);
    }

    var header = block.toHeaders().toJSON();

    var blockOverview = {
      hash: block.hash,
      version: header.version,
      confirmations: null,
      height: header.height,
      chainWork: header.chainwork,
      prevHash: header.prevBlock,
      nextHash: null,
      merkleRoot: block.merkleroot,
      time: header.timestamp,
      medianTime: null,
      nonce: block.nonce,
      bits: block.bits,
      difficulty: null,
      txids: null
    };

    callback(null, blockOverview);
  });

};

BlockService.prototype.getPublishEvents = function() {

  return [
    {
      name: 'block/block',
      scope: this,
      subscribe: this.subscribe.bind(this, 'block'),
      unsubscribe: this.unsubscribe.bind(this, 'block')
    },
    {
      name: 'block/reorg',
      scope: this,
      subscribe: this.subscribe.bind(this, 'reorg'),
      unsubscribe: this.unsubscribe.bind(this, 'reorg')
    }
  ];

};

BlockService.prototype.getRawBlock = function(hash, callback) {
  this.getBlock(hash, function(err, block) {
    if(err) {
      return callback(err);
    }
    callback(null, block.toRaw().toString('hex'));
  });
};

BlockService.prototype.isSynced = function(callback) {
  callback(null, this._p2p.getBestHeight <= this._tip.height);
};

BlockService.prototype.start = function(callback) {

  var self = this;

  async.waterfall([
    function(next) {
      self._db.getPrefix(self.name, next);
    },
    function(prefix, next) {
      self._prefix = prefix;
      self._encoding = new Encoding(self._prefix);
      self._db.getServiceTip('block', next);
    }
  ], function(err, tip) {

    if(err) {
      return callback(err);
    }

    self._setTip(tip);
    self._setListeners();
    self._startSubscriptions();
    callback();

  });

};

BlockService.prototype.stop = function(callback) {
  setImmediate(callback);
};

BlockService.prototype.subscribe = function(name, emitter) {

  this._subscriptions[name].push(emitter);
  log.info(emitter.remoteAddress, 'subscribe:', 'block/' + name, 'total:', this._subscriptions[name].length);

};

BlockService.prototype.syncPercentage = function(callback) {
  var p2pHeight = this._p2p.getBestHeight();
  var percentage =  ((p2pHeight / (this._tip.height || p2pHeight)) * 100).toFixed(2);
  callback(null, percentage);
};

BlockService.prototype.unsubscribe = function(name, emitter) {

  var index = this._subscriptions[name].indexOf(emitter);

  if (index > -1) {
    this._subscriptions[name].splice(index, 1);
  }

  log.info(emitter.remoteAddress, 'unsubscribe:', 'block/' + name, 'total:', this._subscriptions[name].length);

};

// --- start private prototype functions

BlockService.prototype._broadcast = function(subscribers, name, entity) {
  for (var i = 0; i < subscribers.length; i++) {
    subscribers[i].emit(name, entity);
  }
};

BlockService.prototype._detectReorg  = function(block) {
  var prevHash = block.toHeaders().toJSON().prevBlock;
  if (this._tip.hash !== prevHash) {
    return true;
  }
  return false;
};

BlockService.prototype._findCommonAncestor = function(hash, allHeaders, callback) {

  var self = this;
  var count = 0;
  var _oldTip = this._tip.hash;
  var _newTip = hash;

  assert(_newTip && _oldTip, 'current chain and/or new chain do not exist in our list of chain tips.');

  async.whilst(
    // test case
    function() {

      return _oldTip !== _newTip || ++count <= allHeaders.size;

    },
    // get block
    function(next) {

      // old tip has to be in database
      self._db.get(self._encoding.encodeBlockKey(_oldTip), function(err, data) {

        if (err || !data) {
          return next(err || new Error('missing block'));
        }

        var block = self._encoding.decodeBlockValue(data);
        _oldTip = block.toHeaders().toJSON().prevBlock;
        var header = allHeaders.get(_newTip);

        if (!header) {
          return next(new Error('Header missing from list of headers'));
        }

        _newTip = header.prevHash;
        next();

      });

    }, function(err) {

      if (err) {
        return callback(err);
      }

      self._getOldBlocks(_newTip, function(err, oldBlocks) {

        if (err) {
          return callback(err);
        }

        callback(null, hash, _newTip, oldBlocks);

      });

    });
};

BlockService.prototype._getBlock = function(hash, callback) {

  var self = this;

  this._db.get(this._encoding.encodeBlockKey(hash), function(err, data) {

    if(err) {
      return callback(err);
    }

    if (!data) {
      return callback();
    }

    var block = self._encoding.decodeBlockValue(data);
    callback(null, block);

  });
};

BlockService.prototype._getHash = function(blockArg) {

  var headers = this._header.getAllHeaders();

  if (utils.isHeight(blockArg)) {
    return headers.getIndex(blockArg).hash;
  }

};

BlockService.prototype._handleReorg = function(hash, allHeaders) {

  this._reorging = true; // while this is set, we won't be sending blocks

  log.warn('Block Serivce: Chain reorganization detected! Our current block tip is: ' +
    this._tip.hash + ' the current block: ' + hash + '.');

  this._findCommonAncestor(hash, allHeaders, function(err, newHash, commonAncestorHash, oldBlocks) {

    if (err) {

      log.error('Block Service: A common ancestor block between hash: ' +
        this._tip.hash + ' (our current tip) and: ' + newHash +
        ' (the forked block) could not be found. Bitcore-node must exit.');

      this.node.stop();

      return;
    }

    var commonAncestorHeader = allHeaders.get(commonAncestorHash);
    log.warn('Block Service: A common ancestor block was found to at hash: ' + commonAncestorHeader + '.');

    this._broadcast(this.subscriptions.reorg, 'block/reorg', [commonAncestorHeader, oldBlocks]);

    this._onReorg(commonAncestorHeader, oldBlocks);

    this._reorging = false;

  });
};

// get the blocks from our current tip to the given hash, non-inclusive
BlockService.prototype._getOldBlocks = function(hash, callback) {

  var blocks = [];

  var _tip = this._tip.hash;

  async.whilst(
    function() {
      return _tip !== hash;
    },
    function(next) {

      this._get(this._encoding.encodeBlockKey(_tip), function(err, block) {

        if (err) {
          return callback(err);
        }

        if (!block) {
          next(new Error('expected to find a block in database, but found none.'));
          return;
        }
        blocks.push(block);
        _tip = block.toHeaders().toJSON().prevHash;
      });
    },
    function(err) {
      if (err) {
        return callback(err);
      }
      callback(null, blocks);
    });

};

// this JUST rewinds the chain back to the common ancestor block, nothing more
BlockService.prototype._onReorg = function(commonAncestorHeader, oldBlockList) {

  // set the tip to the common ancestor in case something goes wrong with the reorg
  this._setTip({ hash: commonAncestorHeader.hash, height: commonAncestorHeader.height });
  var tipOps = utils.encodeTip(this._tip, this.name);

  var removalOps = [{
    type: 'put',
    key: tipOps.key,
    value: tipOps.value
  }];

  // remove all the old blocks that we reorg from
  oldBlockList.forEach(function(block) {
    removalOps.push({
      type: 'del',
      key: this.encoding.encodeBlockKey(block.rhash()),
    });
  });

  this._db.batch(removalOps);

};

BlockService.prototype._onAllHeaders = function(headers) {
  this._bestHeight = headers.size;
  this._startSync();
};


BlockService.prototype._processBlock = function() {

  var self = this;
  var operations = [];
  var services = self.node.services;
  var block = self._unprocessedBlocks.shift();

  async.eachSeries(
    services,
    function(mod, next) {
      if(mod.onBlock) {
        mod.onBlock.call(mod, block, function(err, ops) {
          if (err) {
            return next(err);
          }
          if (ops) {
            operations = operations.concat(ops);
          }
          next();
        });
      } else {
        setImmediate(next);
      }
    },

    function(err) {

      if (err) {
        log.error('Block Service: Error: ' + err);
        self.node.stop();
        return;
      }

      self._db.batch(operations, function(err) {

        if (err) {
          log.error('Block Service: Error: ' + err);
          self.node.stop();
          return;
        }

        self._tip.height++;
        self._tip.hash = block.rhash();
        var tipOps = utils.encodeTip(self._tip, self.name);

        self._db.put(tipOps.key, tipOps.value, function(err) {

          if (err) {
            log.error('Block Service: Error: ' + err);
            self.node.stop();
            return;
          }

          self._sync();
        });
      });
    }
  );
};

BlockService.prototype.onBlock = function(block, callback) {
  var self = this;


  setImmediate(function() {
    callback(null, [{
    type: 'put',
    key: self._encoding.encodeBlockKey(block.rhash()),
    value: self._encoding.encodeBlockValue(block)
    }]);
  });
};

BlockService.prototype._onBlock = function(block) {

  if (this.node.stopping || this._reorging) {
    return;
  }

  log.debug('Block Service: new block: ' + block.rhash());

  var reorg = this._detectReorg(block);
  if (reorg) {
    this._handleReorg(block, this._header.getAllHeaders());
    return;
  }

  this._unprocessedBlocks.push(block);
  this._processBlock();

};

BlockService.prototype._setListeners = function() {

  this._header.once('headers', this._onAllHeaders.bind(this));
  this._header.on('reorg', this._handleReorg.bind(this));

};

BlockService.prototype._setTip = function(tip) {
  log.debug('Block Service: Setting tip to height: ' + tip.height);
  log.debug('Block Service: Setting tip to hash: ' + tip.hash);
  this._tip = tip;
};

BlockService.prototype._startSync = function() {

  this._numNeeded = this._bestHeight - this._tip.height;
  if (this._numNeeded <= 0) {
    return;
  }

  log.info('Block Service: Gathering: ' + this._numNeeded + ' block(s) from the peer-to-peer network.');

  this._sync();
};

BlockService.prototype._startSubscriptions = function() {
  if (this._subscribed) {
    return;
  }

  this._subscribed = true;
  if (!this._bus) {
    this._bus = this.node.openBus({remoteAddress: 'localhost-block'});
  }

  this._bus.on('header/block', this._onBlock.bind(this));
  this._bus.subscribe('header/block');
};

BlockService.prototype._sync = function() {

  if (this.node.stopping) {
    return;
  }

  var headers = this._header.getAllHeaders();
  var size = headers.size - 1;

  if (this._tip.height < size) {

    if (this._tip.height % 100 === 0) {
      log.info('Block Service: Blocks download progress: ' + this._tip.height + '/' +
        this._bestHeight + '  (' + (this._tip.height / this._bestHeight*100).toFixed(2) + '%)');
    }

    var end = headers.getIndex(Math.min(this._tip.height + BlockService.MAX_BLOCKS + 1, size));
    var endHash = end ? end.hash : null;

    this._p2p.getBlocks({ startHash: this._tip.hash, endHash: endHash });
    return;
  }

};

module.exports = BlockService;