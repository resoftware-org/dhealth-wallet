/*
 * Copyright 2020 NEM (https://nem.io)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and limitations under the License.
 *
 */

import { VersionedObjectStorage } from '../backends/VersionedObjectStorage';
import { HarvestingModel } from '../entities/HarvestingModel';

export class HarvestingModelStorage extends VersionedObjectStorage<HarvestingModel[]> {
    /**
     * Singleton instance as we want to run the migration just once
     */
    public static INSTANCE = new HarvestingModelStorage();

    private constructor() {
        super({
            storageKey: 'harvestingModels',
            migrations: [
                {
                    description: 'dHealth Wallet Table Reset for harvestingModels',
                    migrate: () => undefined,
                },
            ],
        });
    }
}
