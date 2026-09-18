'use strict';

module.exports = {
  ...require('./candidate-contract'),
  ...require('./capture-authorization'),
  ...require('./capture-contract'),
  ...require('./keyword-capture-router'),
  ...require('./retroactive-capture'),
  ...require('./salience-detector'),
};
