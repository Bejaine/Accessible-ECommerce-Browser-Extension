// Speech speed control: Slower / current speed / Faster. The same steps as the "slower" and
// "faster" voice commands; changes are saved to prefs and announced.
import { label } from './strings';

export interface SpeechSpeedControl {
  readonly element: HTMLElement;
  render(rate: number): void;
}

export const formatRate = (rate: number) => `${rate.toFixed(2).replace(/0$/, '')}×`;

export function createSpeechSpeed(
  onStep: (direction: 1 | -1) => void,
  lang?: string,
): SpeechSpeedControl {
  const group = document.createElement('div');
  group.className = 'asl-chips asl-speed';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label('speed.title', lang));

  const button = (key: 'speed.slower' | 'speed.faster', direction: 1 | -1) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label(key, lang);
    b.addEventListener('click', () => onStep(direction));
    return b;
  };
  const value = document.createElement('span');
  value.className = 'asl-speed-value';
  group.append(button('speed.slower', -1), value, button('speed.faster', 1));

  return {
    element: group,
    render(rate) {
      value.textContent = label('speed.now', lang).replace('{rate}', formatRate(rate));
    },
  };
}
