import { type SettingsSectionId } from "./SettingsSearch";
import { SettingsPage } from "./SettingsControls";
import { useI18n } from "../../i18n";

type SoonTabProps = {
  section: SettingsSectionId;
  title: string;
  // Слова, которых нет на странице, но по которым раздел ищут.
  keywords?: string;
};

// Раздел, до которого ещё не дошли руки: настраивать нечего, поэтому вместо
// придуманных строк — заголовок и одно слово. Честнее, чем прятать раздел до
// готовности или показывать неработающие переключатели.
export function SoonTab(props: SoonTabProps) {
  const { t } = useI18n();

  return (
    <SettingsPage
      section={props.section}
      title={props.title}
      keywords={props.keywords}
    >
      <p className="settings-soon">{t("common.soon")}</p>
    </SettingsPage>
  );
}
