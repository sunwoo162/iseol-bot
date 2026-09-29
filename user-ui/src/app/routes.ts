import { createBrowserRouter } from 'react-router';
import Landing from '../pages/Landing';
import NotFound from '../pages/NotFound';
import { LoginPage, SignupPage } from '../pages/Auth';
import Onboarding from '../pages/Onboarding';
import MyWorld from '../pages/MyWorld';
import { CharacterDetail, CharacterCustomize } from '../pages/Character';
import IdeaLab from '../pages/IdeaLab';
import { ProjectList, ProjectWorkspace } from '../pages/Projects';
import AIChat from '../pages/AIChat';
import MemoryVault from '../pages/MemoryVault';
import Learning from '../pages/Learning';
import { TeamRecruit } from '../pages/Teams';
import Community from '../pages/Community';
import Friends from '../pages/Friends';
import { ActivityTimeline, PortfolioPage } from '../pages/PortfolioApi';
import Settings from '../pages/Settings';
import PublicPortfolio from '../pages/PublicPortfolio';
import Profile from '../pages/Profile';
import { HelpPage, PrivacyPage, TermsPage } from '../pages/Information';

export const router = createBrowserRouter([
  { path: '/', Component: Landing },
  { path: '/terms', Component: TermsPage },
  { path: '/privacy', Component: PrivacyPage },
  { path: '/help', Component: HelpPage },
  { path: '/login', Component: LoginPage },
  { path: '/signup', Component: SignupPage },
  { path: '/onboarding', Component: Onboarding },
  { path: '/world', Component: MyWorld },
  { path: '/character', Component: CharacterDetail },
  { path: '/character/customize', Component: CharacterCustomize },
  { path: '/idea-lab', Component: IdeaLab },
  { path: '/projects', Component: ProjectList },
  { path: '/projects/:id', Component: ProjectWorkspace },
  { path: '/ai-chat', Component: AIChat },
  { path: '/memory', Component: MemoryVault },
  { path: '/learning', Component: Learning },
  { path: '/learning/session', Component: Learning },
  { path: '/teams', Component: TeamRecruit },
  { path: '/community', Component: Community },
  { path: '/friends', Component: Friends },
  { path: '/profile', Component: Profile },
  { path: '/activity', Component: ActivityTimeline },
  { path: '/portfolio', Component: PortfolioPage, handle: { productSurface: 'api-backed-portfolio-v1' } },
  { path: '/portfolio/public/:entryId', Component: PublicPortfolio },
  { path: '/settings', Component: Settings },
  { path: '/integrations', Component: Settings },
  { path: '*', Component: NotFound },
], { basename: '/app' });
