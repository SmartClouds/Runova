import * as CountryFlags from 'country-flag-icons/react/3x2';

/**
 * A country's flag from its two-letter code, or nothing for a code it does not know. Drawn as an
 * SVG rather than a flag emoji, since Windows' default emoji font doesn't reliably draw
 * regional-indicator flag glyphs.
 */
export function CountryFlag({
  countryCode,
  className,
}: {
  countryCode: string;
  className?: string;
}): React.JSX.Element | null {
  const Flag = CountryFlags[countryCode.toUpperCase() as keyof typeof CountryFlags];
  if (!Flag) return null;
  return <Flag className={className} />;
}
