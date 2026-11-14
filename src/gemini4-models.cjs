/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const GEMINI4_MODELS = Object.freeze(['gemini-4-carbon', 'gemini-4-argon', 'gemini-4-argon-cyber-permissive']);
const isGemini4Model = model => GEMINI4_MODELS.includes(model);

module.exports = { GEMINI4_MODELS, isGemini4Model };
