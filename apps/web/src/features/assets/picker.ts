/* Public entry of the asset picker for other features (Studio, brand kit, translate…):
 *
 *   import { AssetPicker } from '@/features/assets/picker';
 *   import type { PickedMedia } from '@/features/assets/picker';
 *
 * See the usage example on `AssetPicker`. Importing this module does not pull the assets page. */
export { AssetPicker, pickedFromAsset, pickedFromStock } from './components/AssetPicker';
export type { AssetPickerProps, PickedMedia } from './components/AssetPicker';
export { AssetThumb } from './components/AssetThumb';
export type { AssetThumbProps } from './components/AssetThumb';
